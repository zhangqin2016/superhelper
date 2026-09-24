import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { db } from "../db.js";
import { verifyAccessToken } from "./account-auth.js";
import { verifyGrantToken } from "./mobile-grant-token.js";
import { createRelayRegistry, RELAY_FRAME } from "./mobile-relay-core.js";
import { shapeGrant, shapePendingGrant } from "./mobile-pairing.js";

// Mobile Command WebSocket relay.
//
// Connections are authenticated at upgrade, then routed by the pure registry
// (mobile-relay-core.js):
//  - desktop control channel (protocol 2): `role=desktop` WITHOUT a grantId.
//    The desktop's account token; carries all its pairings. On connect it gets
//    `control.hello` — the full state (active pairings + pending requests) —
//    and afterwards the server PUSHES pairing events down it, so the desktop
//    never polls: a phone that scans, a direct code that is used, an approval,
//    a revocation all arrive the moment they happen.
//  - legacy desktop: `role=desktop&grantId=…` (desktops before protocol 2).
//  - phone: `role=mobile&grantId=…`, with its grant-scoped token.
//
// The relay never interprets conversation frames; it routes them. Admission
// and every conversation decision stay on the desktop.

export const RELAY_PATH = "/api/mobile/relay";
export const CONTROL_PROTOCOL = 2;
const PING_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 256 * 1024;
// Close codes a client acts on (and does not retry).
export const CLOSE_GRANT_ENDED = 4001;
export const CLOSE_REPLACED = 4000;

/**
 * Pure connection-auth decision.
 * @param {object} args
 * @param {object} args.auth - verification result, discriminated by `kind`:
 *   {kind:"account", ok, deviceId, userId, code?} (desktop) or
 *   {kind:"grant", ok, grantId, mobileDeviceId, code?} (mobile)
 * @param {string} args.role - "desktop" | "mobile"
 * @param {string} args.grantId - grantId declared in the query ("" = control channel)
 * @param {string} args.deviceId - device the client declares (must match token)
 * @param {object|null} args.grant - active pairing grant row, or null
 * @returns {{ok:boolean, code?:string, conn?:object}}
 */
export function authenticateRelayConnection({ auth, role, grantId, deviceId, grant }) {
  if (role !== "desktop" && role !== "mobile") return { ok: false, code: "RELAY_ROLE_INVALID" };
  if (!auth?.ok) return { ok: false, code: auth?.code || "RELAY_AUTH_INVALID" };

  if (role === "desktop") {
    if (auth.kind !== "account") return { ok: false, code: "RELAY_AUTH_KIND_INVALID" };
    if (auth.deviceId !== deviceId) return { ok: false, code: "DEVICE_MISMATCH" };
    // No grant: the desktop's control channel. It is bound only to pairings
    // that are this device's and this account's (looked up server-side).
    if (!grantId) return { ok: true, conn: { kind: "channel", deviceId, userId: auth.userId } };
    if (!grant || grant.status !== "active") return { ok: false, code: "RELAY_GRANT_INACTIVE" };
    if (grant.user_id !== auth.userId) return { ok: false, code: "RELAY_GRANT_ACCOUNT_MISMATCH" };
    if (grant.desktop_device_id !== deviceId) return { ok: false, code: "RELAY_GRANT_DEVICE_MISMATCH" };
    return { ok: true, conn: { kind: "legacy", grantId, deviceId, userId: auth.userId } };
  }

  // mobile: grant-scoped token, no account.
  if (!grantId) return { ok: false, code: "RELAY_GRANT_REQUIRED" };
  if (!grant || grant.status !== "active") return { ok: false, code: "RELAY_GRANT_INACTIVE" };
  if (auth.kind !== "grant") return { ok: false, code: "RELAY_AUTH_KIND_INVALID" };
  if (auth.grantId !== grantId) return { ok: false, code: "RELAY_GRANT_TOKEN_MISMATCH" };
  if (auth.mobileDeviceId !== deviceId) return { ok: false, code: "DEVICE_MISMATCH" };
  if (grant.mobile_device_id !== deviceId) return { ok: false, code: "RELAY_GRANT_DEVICE_MISMATCH" };
  return { ok: true, conn: { kind: "mobile", grantId, deviceId, userId: grant.user_id } };
}

/**
 * The presence frame a connection should see for a pairing: a phone is told
 * whether its desktop is on the line; a desktop how many phones are.
 */
export function presenceFrameFor(kind, presence, grantId = "") {
  if (kind === "mobile") return { type: "relay.presence", desktopOnline: Boolean(presence?.desktop) };
  if (kind === "channel") return { type: "control.presence", grantId, mobilesOnline: Number(presence?.mobiles || 0) };
  return { type: "relay.presence", mobilesOnline: Number(presence?.mobiles || 0) };
}

export function peerOfflineFrameForMessage(frame) {
  const out = { type: "relay.peer_offline" };
  if (frame?.commandId) out.commandId = String(frame.commandId);
  if (frame?.correlationId) out.correlationId = String(frame.correlationId);
  return out;
}

// --- server → desktop control events ------------------------------------------
//
// HTTP routes change pairings; the live relay tells the desktop and ends
// sockets. One process, one relay: routes call these after their DB write.

let liveRelay = null;

export const relayControl = {
  /** A phone consumed a QR code: the desktop can show the approval now. */
  pairingRequested(grantRow) {
    try { liveRelay?.pairingRequested(grantRow); } catch { /* the HTTP answer never depends on this */ }
  },
  /** A pairing became active (approved, or a direct code was used). */
  grantActivated(grantRow) {
    try { liveRelay?.grantActivated(grantRow); } catch { /* ditto */ }
  },
  /** A pairing ended (revoked, denied, superseded): close its sockets now. */
  grantEnded(grantId, reason = "revoked") {
    try { return liveRelay?.grantEnded(String(grantId || ""), reason) || 0; } catch { return 0; }
  },
};

async function lookupActiveGrant(grantId) {
  if (!grantId) return null;
  return db
    .selectFrom("mobile_pairing_grants")
    .selectAll()
    .where("id", "=", grantId)
    .where("status", "=", "active")
    .executeTakeFirst();
}

async function loadDesktopState({ deviceId, userId, now = new Date() }) {
  const rows = await db
    .selectFrom("mobile_pairing_grants")
    .selectAll()
    .where("desktop_device_id", "=", deviceId)
    .where("user_id", "=", userId)
    .where("status", "in", ["active", "pending_approval"])
    .orderBy("created_at", "asc")
    .execute();
  const nowIso = now.toISOString();
  return {
    grants: rows.filter((row) => row.status === "active"),
    pending: rows.filter((row) => row.status === "pending_approval" && String(row.approval_expires_at || "") > nowIso),
  };
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

function parseFrame(data) {
  try {
    const frame = JSON.parse(data.toString("utf8"));
    return frame && typeof frame === "object" && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

/**
 * Attach the relay to a Fastify app's underlying http server. Injectable deps
 * keep the auth and state paths testable; production uses the real verifiers
 * and the database.
 */
export function registerMobileRelay(app, deps = {}) {
  const verifyToken = deps.verifyAccessToken || verifyAccessToken;
  const verifyGrant = deps.verifyGrantToken || verifyGrantToken;
  const lookupGrant = deps.lookupActiveGrant || lookupActiveGrant;
  const loadState = deps.loadDesktopState || loadDesktopState;
  const registry = deps.registry || createRelayRegistry();
  const authForRole = (role, token) => {
    if (role === "desktop") {
      const v = verifyToken(token);
      return { kind: "account", ok: Boolean(v?.ok), code: v?.code, deviceId: v?.deviceId, userId: v?.userId };
    }
    const v = verifyGrant(token);
    return { kind: "grant", ok: Boolean(v?.ok), code: v?.code, grantId: v?.grantId, mobileDeviceId: v?.mobileDeviceId };
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const sockets = new Map(); // connId -> ws

  function send(connId, frame) {
    const ws = sockets.get(connId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function closeConn(connId, code, reason) {
    const ws = sockets.get(connId);
    sockets.delete(connId);
    try { ws?.close?.(code, reason); } catch { /* noop */ }
  }

  function announcePresence(grantId) {
    const presence = registry.presence(grantId);
    const { desktop, desktopKind, mobiles } = registry.connsForGrant(grantId);
    if (desktop) send(desktop, presenceFrameFor(desktopKind, presence, grantId));
    for (const connId of mobiles) send(connId, presenceFrameFor("mobile", presence));
  }

  liveRelay = {
    pairingRequested(row) {
      const channel = registry.channelFor(row?.desktop_device_id);
      if (channel && registry.connInfo(channel)?.userId === row.user_id) {
        send(channel, { type: "control.pairing.pending", grant: shapePendingGrant(row) });
      }
    },
    grantActivated(row) {
      const channel = registry.channelFor(row?.desktop_device_id);
      if (!channel || registry.connInfo(channel)?.userId !== row.user_id) return;
      const displaced = registry.bindGrant(channel, row.id);
      if (displaced) closeConn(displaced, CLOSE_REPLACED, "REPLACED_BY_CHANNEL");
      send(channel, { type: "control.grant.active", grant: shapeGrant(row) });
      announcePresence(row.id);
    },
    grantEnded(grantId, reason) {
      const { mobiles, legacyDesktop, channel } = registry.endGrant(grantId);
      for (const connId of mobiles) closeConn(connId, CLOSE_GRANT_ENDED, "GRANT_ENDED");
      if (legacyDesktop) closeConn(legacyDesktop, CLOSE_GRANT_ENDED, "GRANT_ENDED");
      if (channel) send(channel, { type: "control.grant.ended", grantId, reason });
      return mobiles.length + (legacyDesktop ? 1 : 0);
    },
  };

  function register(connId, conn, state) {
    if (conn.kind === "channel") {
      return registry.addChannel({ connId, deviceId: conn.deviceId, userId: conn.userId, grantIds: state.grants.map((g) => g.id) });
    }
    if (conn.kind === "legacy") return registry.addLegacyDesktop({ connId, grantId: conn.grantId, deviceId: conn.deviceId });
    return { ...registry.addMobile({ connId, grantId: conn.grantId, deviceId: conn.deviceId }), replaced: [] };
  }

  wss.on("connection", (ws, _request, conn, state) => {
    const connId = `relayconn_${crypto.randomUUID()}`;
    const added = register(connId, conn, state);
    if (!added.ok) {
      try { ws.close(4003, added.code); } catch { /* noop */ }
      return;
    }
    for (const stale of added.replaced || []) closeConn(stale, CLOSE_REPLACED, "REPLACED_BY_RECONNECT");
    sockets.set(connId, ws);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (data) => {
      if (data && data.length > MAX_MESSAGE_BYTES) { try { ws.close(4009, "MESSAGE_TOO_LARGE"); } catch { /* noop */ } return; }
      const frame = parseFrame(data);
      if (!frame) return;
      const routed = registry.route(connId, frame);
      if (!routed.ok) {
        send(connId, { type: "relay.error", code: routed.code });
        return;
      }
      if (!routed.deliveries.length) {
        if (conn.kind === "mobile") send(connId, peerOfflineFrameForMessage(frame));
        return;
      }
      const raw = JSON.stringify(routed.frame);
      for (const delivery of routed.deliveries) {
        send(delivery.connId, delivery.wrap ? `{"type":"${RELAY_FRAME}","grantId":${JSON.stringify(delivery.grantId)},"frame":${raw}}` : raw);
      }
    });
    ws.on("close", () => {
      if (sockets.get(connId) === ws) sockets.delete(connId);
      const removed = registry.remove(connId);
      for (const grantId of removed.grantIds || []) announcePresence(grantId);
    });

    if (conn.kind === "channel") {
      send(connId, {
        type: "control.hello",
        protocol: CONTROL_PROTOCOL,
        grants: state.grants.map(shapeGrant),
        pending: state.pending.map(shapePendingGrant),
      });
      for (const grant of state.grants) announcePresence(grant.id);
    } else {
      send(connId, { type: "relay.ready", role: conn.kind === "mobile" ? "mobile" : "desktop" });
      announcePresence(conn.grantId);
    }
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
    let state = { grants: [], pending: [] };
    try {
      const auth = authForRole(params.role, params.token);
      const grant = auth.ok && params.grantId ? await lookupGrant(params.grantId) : null;
      decision = authenticateRelayConnection({ auth, role: params.role, grantId: params.grantId, deviceId: params.deviceId, grant });
      if (decision.ok && decision.conn.kind === "channel") {
        state = await loadState({ deviceId: decision.conn.deviceId, userId: decision.conn.userId });
      }
    } catch {
      decision = { ok: false, code: "RELAY_AUTH_ERROR" };
    }
    if (!decision.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, decision.conn, state));
  });

  app.addHook("onClose", (_instance, done) => {
    clearInterval(heartbeat);
    if (liveRelay?.grantEnded && liveRelay.registry === registry) liveRelay = null;
    try { wss.close(); } catch { /* noop */ }
    done();
  });

  liveRelay.registry = registry;
  return { wss, registry, control: relayControl };
}
