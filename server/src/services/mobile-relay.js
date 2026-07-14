import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { db } from "../db.js";
import { verifyAccessToken } from "./account-auth.js";
import { verifyGrantToken } from "./mobile-grant-token.js";
import { createRelayRegistry } from "./mobile-relay-core.js";

// Mobile Command WebSocket relay (Phase 1 text channel transport).
//
// A desktop and its paired mobile each open one authenticated WS to
// /api/mobile/relay?role=…&grantId=…&deviceId=…&token=…, then route messages
// through the pure registry: a mobile's command envelope → the grant's desktop
// (which feeds admitExternalCommand); a desktop's turn projection → the grant's
// mobile. Nothing crosses grants.
//
// Two auth kinds by role (desktop-vouched model):
//  - desktop: its ACCOUNT access token (the desktop user is logged in).
//  - mobile: a GRANT-scoped token minted at consume (no account; the phone never
//    logs in). Either way the grant must be active and bind that device.
//
// The decision is a pure function (authenticateRelayConnection) so its rules are
// unit-tested without a socket; the glue supplies the verifiers + grant lookup.

const RELAY_PATH = "/api/mobile/relay";
const PING_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * Pure connection-auth decision.
 * @param {object} args
 * @param {object} args.auth - verification result, discriminated by `kind`:
 *   {kind:"account", ok, deviceId, userId, code?} (desktop) or
 *   {kind:"grant", ok, grantId, mobileDeviceId, code?} (mobile)
 * @param {string} args.role - "desktop" | "mobile"
 * @param {string} args.grantId - grantId declared in the query
 * @param {string} args.deviceId - device the client declares (must match token)
 * @param {object|null} args.grant - active pairing grant row, or null
 * @returns {{ok:boolean, code?:string, conn?:object}}
 */
export function authenticateRelayConnection({ auth, role, grantId, deviceId, grant }) {
  if (role !== "desktop" && role !== "mobile") return { ok: false, code: "RELAY_ROLE_INVALID" };
  if (!auth?.ok) return { ok: false, code: auth?.code || "RELAY_AUTH_INVALID" };
  if (!grantId) return { ok: false, code: "RELAY_GRANT_REQUIRED" };
  if (!grant || grant.status !== "active") return { ok: false, code: "RELAY_GRANT_INACTIVE" };

  if (role === "desktop") {
    if (auth.kind !== "account") return { ok: false, code: "RELAY_AUTH_KIND_INVALID" };
    if (auth.deviceId !== deviceId) return { ok: false, code: "DEVICE_MISMATCH" };
    if (grant.user_id !== auth.userId) return { ok: false, code: "RELAY_GRANT_ACCOUNT_MISMATCH" };
    if (grant.desktop_device_id !== deviceId) return { ok: false, code: "RELAY_GRANT_DEVICE_MISMATCH" };
    return { ok: true, conn: { role, grantId, deviceId, userId: auth.userId } };
  }

  // mobile: grant-scoped token, no account.
  if (auth.kind !== "grant") return { ok: false, code: "RELAY_AUTH_KIND_INVALID" };
  if (auth.grantId !== grantId) return { ok: false, code: "RELAY_GRANT_TOKEN_MISMATCH" };
  if (auth.mobileDeviceId !== deviceId) return { ok: false, code: "DEVICE_MISMATCH" };
  if (grant.mobile_device_id !== deviceId) return { ok: false, code: "RELAY_GRANT_DEVICE_MISMATCH" };
  return { ok: true, conn: { role, grantId, deviceId, userId: grant.user_id } };
}

export function peerOfflineFrameForMessage(message) {
  const frame = { type: "relay.peer_offline" };
  try {
    const parsed = JSON.parse(String(message || ""));
    if (parsed?.commandId) frame.commandId = String(parsed.commandId);
    if (parsed?.correlationId) frame.correlationId = String(parsed.correlationId);
  } catch {
    // Keep relay dumb and fail-open: unparseable frames still get generic offline feedback.
  }
  return frame;
}

async function lookupActiveGrant(grantId) {
  if (!grantId) return null;
  return db
    .selectFrom("mobile_pairing_grants")
    .selectAll()
    .where("id", "=", grantId)
    .where("status", "=", "active")
    .executeTakeFirst();
}

function parseParams(url) {
  const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const p = new URLSearchParams(qs);
  return {
    role: String(p.get("role") || ""),
    grantId: String(p.get("grantId") || ""),
    deviceId: String(p.get("deviceId") || ""),
    token: String(p.get("token") || ""),
  };
}

/**
 * Attach the relay to a Fastify app's underlying http server. Idempotent per
 * app. Injectable deps keep the auth path testable; production uses the real
 * token verifier and grant lookup.
 */
export function registerMobileRelay(app, deps = {}) {
  const verifyToken = deps.verifyAccessToken || verifyAccessToken;
  const verifyGrant = deps.verifyGrantToken || verifyGrantToken;
  const lookupGrant = deps.lookupActiveGrant || lookupActiveGrant;
  const registry = deps.registry || createRelayRegistry();
  // Build the role-appropriate auth object: desktop = account token, mobile =
  // grant-scoped token.
  const authForRole = (role, token) => {
    if (role === "desktop") {
      const v = verifyToken(token);
      return { kind: "account", ok: Boolean(v?.ok), code: v?.code, deviceId: v?.deviceId, userId: v?.userId };
    }
    const v = verifyGrant(token);
    return { kind: "grant", ok: Boolean(v?.ok), code: v?.code, grantId: v?.grantId, mobileDeviceId: v?.mobileDeviceId };
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  function send(connId, message) {
    const ws = sockets.get(connId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  const sockets = new Map(); // connId -> ws

  wss.on("connection", (ws, request, conn) => {
    const connId = `relayconn_${crypto.randomUUID()}`;
    const added = registry.add({ connId, role: conn.role, grantId: conn.grantId, deviceId: conn.deviceId });
    if (!added.ok) {
      try { ws.close(4003, added.code); } catch { /* noop */ }
      return;
    }
    if (added.replaced) {
      const stale = sockets.get(added.replaced);
      sockets.delete(added.replaced);
      try { stale?.close?.(4000, "REPLACED_BY_RECONNECT"); } catch { /* noop */ }
    }
    sockets.set(connId, ws);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (data) => {
      if (data && data.length > MAX_MESSAGE_BYTES) { try { ws.close(4009, "MESSAGE_TOO_LARGE"); } catch { /* noop */ } return; }
      const { targets } = registry.targetsFor(connId);
      // Relay is a dumb pipe for Phase 1: it forwards the raw frame to the
      // peer(s) of the same grant. Envelope validation/admission happens on the
      // desktop via admitExternalCommand, not here.
      const text = data.toString("utf8");
      if (!targets.length) {
        send(connId, JSON.stringify(peerOfflineFrameForMessage(text)));
        return;
      }
      for (const target of targets) send(target, text);
    });
    ws.on("close", () => {
      sockets.delete(connId);
      registry.remove(connId);
    });
    send(connId, JSON.stringify({ type: "relay.ready", role: conn.role }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* noop */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref?.();

  app.server.on("upgrade", async (request, socket, head) => {
    let pathname = "";
    try { pathname = new URL(request.url, "http://localhost").pathname; } catch { pathname = ""; }
    if (pathname !== RELAY_PATH) return; // let other upgrade handlers (if any) run
    const params = parseParams(request.url || "");
    let decision;
    try {
      const auth = authForRole(params.role, params.token);
      const grant = auth.ok ? await lookupGrant(params.grantId) : null;
      decision = authenticateRelayConnection({ auth, role: params.role, grantId: params.grantId, deviceId: params.deviceId, grant });
    } catch {
      decision = { ok: false, code: "RELAY_AUTH_ERROR" };
    }
    if (!decision.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, decision.conn));
  });

  app.addHook("onClose", (_instance, done) => {
    clearInterval(heartbeat);
    try { wss.close(); } catch { /* noop */ }
    done();
  });

  return { wss, registry };
}
