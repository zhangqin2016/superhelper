import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";

// Full-stack Mobile Command (Phase 1) end-to-end against the REAL server app +
// a REAL Postgres: it drives the whole pairing → relay → command round-trip the
// way a desktop + phone would, everything short of the physical device.
//
//   desktop challenge → mobile consume → desktop sees pending → desktop approve
//   → both roles connect the relay WebSocket → mobile command frame reaches the
//   desktop socket (and a desktop projection reaches the mobile socket).
//
// This is the automated proxy for the on-device 1-6 validation: it exercises the
// real routes, the device-signature + account-session guards, the composite-FK
// grant rows, and the live WS relay auth/fan-out. It SKIPS cleanly (exit 0) when
// no database is reachable, matching server/scripts/integration.mjs.

process.env.DATABASE_URL ||= "postgres://integration:integration@localhost:5432/integration";
process.env.ADMIN_TOKEN ||= "integration-token";
process.env.ALLOW_UNSIGNED_LICENSES ||= "true";
process.env.PUBLIC_BASE_URL ||= "https://lily.integration.test";
process.env.QINIU_ACCESS_KEY ||= "integration-qiniu-ak";
process.env.QINIU_SECRET_KEY ||= "integration-qiniu-sk";
process.env.QINIU_BUCKET ||= "integration-bucket";
process.env.QINIU_PUBLIC_BASE_URL ||= "https://qiniu.integration.test";
process.env.MODEL_GATEWAY_PROVIDERS ||= JSON.stringify({});

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
function base64urlEncode(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

// The exact device-request signature the server verifies (device-identity.js).
function signedHeaders({ method, pathname, payload, deviceId, privateKey }) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = sha256(stableStringify(payload));
  const canonical = { method: method.toUpperCase(), pathname, timestamp, nonce, bodyHash };
  const signature = crypto.sign(null, Buffer.from(stableStringify(canonical)), crypto.createPrivateKey(privateKey));
  return {
    "X-Lily-Device-Id": deviceId,
    "X-Lily-Key-Alg": "ed25519",
    "X-Lily-Timestamp": timestamp,
    "X-Lily-Nonce": nonce,
    "X-Lily-Body-Sha256": bodyHash,
    "X-Lily-Signature": base64urlEncode(signature),
  };
}

async function hasDatabase() {
  try { await pool.query("select 1"); return true; } catch { return false; }
}

// Wait for a specific frame type on a socket, or reject on timeout.
function waitForFrame(ws, predicate, label, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    function onMessage(data) {
      let frame; try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
      if (predicate(frame)) { cleanup(); resolve(frame); }
    }
    function cleanup() { clearTimeout(timer); ws.off("message", onMessage); }
    ws.on("message", onMessage);
  });
}

function connectRelay(base, { role, grantId, deviceId, token }) {
  const url = `${base.replace(/^http/, "ws")}/api/mobile/relay?role=${role}&grantId=${encodeURIComponent(grantId)}&deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}`;
  return new WebSocket(url);
}

if (!(await hasDatabase())) {
  console.log("mobile-command-e2e: skipped (DATABASE_URL unavailable)");
  await pool.end();
  process.exit(0);
}

let app = null;
try {
  const fs = await import("node:fs");
  const migrationFiles = fs.readdirSync(new URL("../migrations", import.meta.url)).filter((n) => n.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }

  const { buildApp } = await import("../src/app.js");
  const { createAccessToken, hashRefreshToken } = await import("../src/services/account-auth.js");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const runId = Date.now();
  const adminHeaders = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

  // --- A license the desktop device activates (creates the license_devices
  // binding the grant's composite FK requires + registers the device key). ---
  const created = await app.inject({
    method: "POST", url: "/api/admin/licenses", headers: adminHeaders,
    payload: { customerName: "MobileE2E", plan: "pro", seats: 2, expiresAt: new Date(Date.now() + 86400_000).toISOString(), features: ["updates"] },
  });
  assert.equal(created.statusCode, 201, "license created");
  const licenseKey = created.json().licenseKey;

  const desktopDeviceId = `dev_desktop_${runId}`;
  const mobileDeviceId = `dev_mobile_${runId}`;
  const dk = crypto.generateKeyPairSync("ed25519");
  const desktopPub = dk.publicKey.export({ type: "spki", format: "pem" });
  const desktopPriv = dk.privateKey.export({ type: "pkcs8", format: "pem" });

  const activate = await app.inject({
    method: "POST", url: "/api/licenses/activate",
    payload: { deviceId: desktopDeviceId, fingerprintHash: "e2e-hash", platform: "darwin", arch: "arm64", appVersion: "0.0.0", publicKey: desktopPub, keyAlg: "ed25519", licenseKey },
  });
  assert.equal(activate.statusCode, 200, "desktop device activated");

  // Mobile device only needs a row (account-guarded, no device signature).
  const regMobile = await app.inject({ method: "POST", url: "/api/devices/register", payload: { deviceId: mobileDeviceId, fingerprintHash: "e2e-mob", platform: "ios", arch: "arm64", appVersion: "0.0.0" } });
  assert.equal(regMobile.statusCode, 200, "mobile device registered");

  // --- One account, two sessions (desktop + mobile) — pairing requires the
  // same user on both sides. ---
  const userId = `usr_e2e_${runId}`;
  await pool.query("insert into users (id, phone_e164, status, last_login_at) values ($1, $2, 'active', now())", [userId, `+86139${String(runId).slice(-8)}`]);
  const desktopSessionId = `sess_desktop_${runId}`;
  const mobileSessionId = `sess_mobile_${runId}`;
  await pool.query(
    "insert into user_sessions (id, user_id, device_id, refresh_token_hash, expires_at, last_seen_at) values ($1, $2, $3, $4, now() + interval '7 days', now())",
    [desktopSessionId, userId, desktopDeviceId, hashRefreshToken(`e2e_d_${runId}`)],
  );
  await pool.query(
    "insert into user_sessions (id, user_id, device_id, refresh_token_hash, expires_at, last_seen_at) values ($1, $2, $3, $4, now() + interval '7 days', now())",
    [mobileSessionId, userId, mobileDeviceId, hashRefreshToken(`e2e_m_${runId}`)],
  );
  const desktopToken = createAccessToken({ userId, sessionId: desktopSessionId, deviceId: desktopDeviceId, scopes: ["account"] });
  const mobileToken = createAccessToken({ userId, sessionId: mobileSessionId, deviceId: mobileDeviceId, scopes: ["account"] });

  const desktopBody = (extra) => ({ deviceId: desktopDeviceId, ...extra });
  const desktopPost = (pathname, body) => app.inject({
    method: "POST", url: pathname,
    headers: { Authorization: `Bearer ${desktopToken}`, ...signedHeaders({ method: "POST", pathname, payload: body, deviceId: desktopDeviceId, privateKey: desktopPriv }) },
    payload: body,
  });

  // --- 1. Desktop issues a challenge. ---
  const challenge = await desktopPost("/api/mobile/pairing/challenge", desktopBody({}));
  assert.equal(challenge.statusCode, 200, `challenge ok: ${challenge.body}`);
  const pairingToken = challenge.json().token;
  assert.ok(pairingToken && pairingToken.length >= 10, "challenge returns a token");

  // --- 2. Mobile consumes it (account token only, no device signature). ---
  const consume = await app.inject({
    method: "POST", url: "/api/mobile/pairing/consume",
    headers: { Authorization: `Bearer ${mobileToken}` },
    payload: { deviceId: mobileDeviceId, token: pairingToken },
  });
  assert.equal(consume.statusCode, 200, `consume ok: ${consume.body}`);
  const grantId = consume.json().grantId;
  assert.ok(grantId, "consume returns a pending grant id");

  // --- 3. Desktop sees the pending request. ---
  const pending = await desktopPost("/api/mobile/pairing/pending", desktopBody({}));
  assert.equal(pending.statusCode, 200, "pending ok");
  assert.ok(pending.json().grants.some((g) => g.grantId === grantId || g.id === grantId), "the pending grant is listed for the desktop");

  // --- 4. Relay must refuse before approval (grant not active). ---
  {
    const early = connectRelay(base, { role: "mobile", grantId, deviceId: mobileDeviceId, token: mobileToken });
    const refused = await new Promise((resolve) => {
      early.on("open", () => resolve("open"));
      early.on("error", () => resolve("refused"));
      early.on("unexpected-response", () => resolve("refused"));
    });
    try { early.close(); } catch { /* noop */ }
    assert.equal(refused, "refused", "relay refuses a mobile connection before approval");
  }

  // --- 5. Desktop approves → grant active. ---
  const approve = await desktopPost("/api/mobile/pairing/approve", desktopBody({ grantId }));
  assert.equal(approve.statusCode, 200, `approve ok: ${approve.body}`);
  assert.equal(approve.json().status, "active", "grant is active after approval");

  // --- 6. Both roles connect the relay. ---
  const desktopWs = connectRelay(base, { role: "desktop", grantId, deviceId: desktopDeviceId, token: desktopToken });
  const mobileWs = connectRelay(base, { role: "mobile", grantId, deviceId: mobileDeviceId, token: mobileToken });
  await Promise.all([
    waitForFrame(desktopWs, (f) => f.type === "relay.ready", "desktop relay.ready"),
    waitForFrame(mobileWs, (f) => f.type === "relay.ready", "mobile relay.ready"),
  ]);

  // --- 7. Mobile command frame reaches the desktop socket (dumb-pipe relay). ---
  const commandId = `cmd_e2e_${runId}`;
  const commandFrame = { type: "command", commandId, idempotencyKey: commandId, text: "从手机端到端发来的任务", mobileDeviceId, lilySessionId: "", mode: "queue" };
  const desktopGotCommand = waitForFrame(desktopWs, (f) => f.type === "command" && f.commandId === commandId, "desktop receives the command");
  mobileWs.send(JSON.stringify(commandFrame));
  const received = await desktopGotCommand;
  assert.equal(received.text, commandFrame.text, "the command text round-trips to the desktop");
  assert.equal(received.mobileDeviceId, mobileDeviceId, "the mobile device id round-trips");

  // --- 8. Desktop projection reaches the mobile socket (the ack path). ---
  const ackFrame = { type: "command.admitted", commandId, effectiveMode: "queue" };
  const mobileGotAck = waitForFrame(mobileWs, (f) => f.type === "command.admitted" && f.commandId === commandId, "mobile receives the ack");
  desktopWs.send(JSON.stringify(ackFrame));
  const ack = await mobileGotAck;
  assert.equal(ack.effectiveMode, "queue", "the admission ack round-trips back to mobile");

  try { desktopWs.close(); mobileWs.close(); } catch { /* noop */ }

  // --- 9. Revoke tears the grant down; a fresh connect is refused. ---
  const revoke = await desktopPost("/api/mobile/pairing/revoke", desktopBody({ grantId, reason: "e2e" }));
  assert.equal(revoke.statusCode, 200, "revoke ok");
  {
    const afterRevoke = connectRelay(base, { role: "mobile", grantId, deviceId: mobileDeviceId, token: mobileToken });
    const refused = await new Promise((resolve) => {
      afterRevoke.on("open", () => resolve("open"));
      afterRevoke.on("error", () => resolve("refused"));
      afterRevoke.on("unexpected-response", () => resolve("refused"));
    });
    try { afterRevoke.close(); } catch { /* noop */ }
    assert.equal(refused, "refused", "relay refuses after the grant is revoked");
  }

  console.log("mobile-command-e2e: ok");
} finally {
  try { await app?.close(); } catch { /* noop */ }
  await pool.end();
}
