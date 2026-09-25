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

  // Desktop-vouched model: the phone has NO account/session. Register only its
  // device row; it gets a grant-scoped token from consume, not a login.
  const regMobile = await app.inject({ method: "POST", url: "/api/devices/register", payload: { deviceId: mobileDeviceId, fingerprintHash: "e2e-mob", platform: "ios", arch: "arm64", appVersion: "0.0.0" } });
  assert.equal(regMobile.statusCode, 200, "mobile device registered");

  // --- Desktop account + session (the desktop is the authenticated side). ---
  const userId = `usr_e2e_${runId}`;
  await pool.query("insert into users (id, phone_e164, status, last_login_at) values ($1, $2, 'active', now())", [userId, `+86139${String(runId).slice(-8)}`]);
  const desktopSessionId = `sess_desktop_${runId}`;
  await pool.query(
    "insert into user_sessions (id, user_id, device_id, refresh_token_hash, expires_at, last_seen_at) values ($1, $2, $3, $4, now() + interval '7 days', now())",
    [desktopSessionId, userId, desktopDeviceId, hashRefreshToken(`e2e_d_${runId}`)],
  );
  const desktopToken = createAccessToken({ userId, sessionId: desktopSessionId, deviceId: desktopDeviceId, scopes: ["account"] });

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

  // --- 2. Mobile consumes it with NO login — just its device id + the token.
  // The response carries a grant-scoped token that is the phone's only credential. ---
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const consume = await app.inject({
    method: "POST", url: "/api/mobile/pairing/consume",
    headers: { "user-agent": IPHONE_UA },
    payload: { deviceId: mobileDeviceId, token: pairingToken },
  });
  assert.equal(consume.statusCode, 200, `consume ok: ${consume.body}`);
  const grantId = consume.json().grantId;
  const mobileToken = consume.json().mobileToken;
  assert.ok(grantId, "consume returns a pending grant id");
  assert.ok(mobileToken && mobileToken.startsWith("lily_mgrant_"), "consume returns a grant-scoped token (no login)");

  // --- 3. Desktop sees the pending request. ---
  const pending = await desktopPost("/api/mobile/pairing/pending", desktopBody({}));
  assert.equal(pending.statusCode, 200, "pending ok");
  assert.ok(pending.json().grants.some((g) => g.grantId === grantId || g.id === grantId), "the pending grant is listed for the desktop");
  assert.equal(pending.json().grants.find((g) => g.grantId === grantId)?.mobileLabel, "iPhone · Safari", "the desktop is told WHICH phone asks (from its User-Agent)");

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

  // --- 6. Both roles connect the relay; each is told the other is there. ---
  const desktopWs = connectRelay(base, { role: "desktop", grantId, deviceId: desktopDeviceId, token: desktopToken });
  await waitForFrame(desktopWs, (f) => f.type === "relay.ready", "desktop relay.ready");
  const desktopSeesPhone = waitForFrame(desktopWs, (f) => f.type === "relay.presence" && f.mobilesOnline === 1, "desktop sees the phone come online");
  const mobileWs = connectRelay(base, { role: "mobile", grantId, deviceId: mobileDeviceId, token: mobileToken });
  const mobileSeesDesktop = waitForFrame(mobileWs, (f) => f.type === "relay.presence" && f.desktopOnline === true, "phone sees the desktop online");
  await waitForFrame(mobileWs, (f) => f.type === "relay.ready", "mobile relay.ready");
  await Promise.all([desktopSeesPhone, mobileSeesDesktop]);

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

  // --- 8a. The desktop drops off: the phone is told, instead of typing into the void. ---
  const phoneSeesOffline = waitForFrame(mobileWs, (f) => f.type === "relay.presence" && f.desktopOnline === false, "phone sees the desktop go offline");
  desktopWs.close();
  await phoneSeesOffline;
  const mobileClosed = new Promise((resolve) => mobileWs.on("close", (code) => resolve(code)));

  // --- 8b. Re-scan while a grant is ALREADY LIVE: consume must supersede the
  // old pairing (revoke it) and succeed, not fail PAIRING_ALREADY_LIVE. This is
  // the real-world "same phone re-pairs" case that used to wedge on the
  // live-pair unique index. ---
  const challenge2 = await desktopPost("/api/mobile/pairing/challenge", desktopBody({}));
  assert.equal(challenge2.statusCode, 200, "second challenge ok");
  const consume2 = await app.inject({
    method: "POST", url: "/api/mobile/pairing/consume",
    payload: { deviceId: mobileDeviceId, token: challenge2.json().token },
  });
  assert.equal(consume2.statusCode, 200, `re-scan consume supersedes the live grant: ${consume2.body}`);
  assert.ok(consume2.json().grantId && consume2.json().grantId !== grantId, "re-scan yields a fresh grant");
  const supersededCode = await Promise.race([mobileClosed, new Promise((r) => setTimeout(() => r("still-open"), 3000))]);
  assert.equal(supersededCode, 4001, "the superseded pairing's OPEN socket is closed at once, not left authenticated");

  // --- 9. Revoke the (current) grant; a fresh connect is refused. ---
  const grant2 = consume2.json().grantId;
  const token2 = consume2.json().mobileToken;
  const revoke = await desktopPost("/api/mobile/pairing/revoke", desktopBody({ grantId: grant2, reason: "e2e" }));
  assert.equal(revoke.statusCode, 200, "revoke ok");
  {
    const afterRevoke = connectRelay(base, { role: "mobile", grantId: grant2, deviceId: mobileDeviceId, token: token2 });
    const refused = await new Promise((resolve) => {
      afterRevoke.on("open", () => resolve("open"));
      afterRevoke.on("error", () => resolve("refused"));
      afterRevoke.on("unexpected-response", () => resolve("refused"));
    });
    try { afterRevoke.close(); } catch { /* noop */ }
    assert.equal(refused, "refused", "relay refuses after the grant is revoked");
  }

  // --- 10. Direct connect (TeamViewer/ToDesk-style): code + password, no
  // approval → an ACTIVE grant the relay accepts immediately. ---
  const dc = await desktopPost("/api/mobile/direct/create", desktopBody({}));
  assert.equal(dc.statusCode, 200, `direct create ok: ${dc.body}`);
  const { code: directCode, password: directPassword } = dc.json();
  assert.ok(directCode && directPassword, "direct create returns code + password once");

  // wrong password is rejected (opaque)
  const wrong = await app.inject({ method: "POST", url: "/api/mobile/direct/consume", payload: { deviceId: mobileDeviceId, code: directCode, password: "WRONG9" } });
  assert.equal(wrong.statusCode, 409, "wrong password refused");
  assert.equal(wrong.json().code, "DIRECT_CODE_INVALID");

  // correct code+password (lowercase, to prove normalization) → active grant
  const dconsume = await app.inject({ method: "POST", url: "/api/mobile/direct/consume", payload: { deviceId: mobileDeviceId, code: directCode.toLowerCase(), password: directPassword.toLowerCase() } });
  assert.equal(dconsume.statusCode, 200, `direct consume ok: ${dconsume.body}`);
  const directGrant = dconsume.json().grantId;
  const directToken = dconsume.json().mobileToken;
  assert.ok(directGrant && directToken, "direct consume yields an active grant + token");

  // the relay accepts it right away (no approval step)
  const directWs = connectRelay(base, { role: "mobile", grantId: directGrant, deviceId: mobileDeviceId, token: directToken });
  const directReady = await waitForFrame(directWs, (f) => f.type === "relay.ready", "direct relay.ready");
  assert.equal(directReady.role, "mobile", "direct-connected phone joins the relay without approval");
  try { directWs.close(); } catch { /* noop */ }

  // --- 11. Mobile ASR token: the grant token buys a vision-scoped gateway
  // token for server dictation. Wrong grant/device is refused. ---
  const asrOk = await app.inject({ method: "POST", url: "/api/mobile/asr/token", payload: { deviceId: mobileDeviceId, grantId: directGrant, token: directToken } });
  assert.equal(asrOk.statusCode, 200, `asr token ok: ${asrOk.body}`);
  assert.ok(asrOk.json().asrToken, "returns a vision-scoped ASR token");
  {
    // The token must pass the gateway's LIVE check (a logout closes it): it
    // carries the desktop's login session. Without it every phone got 401
    // USER_LOGIN_REQUIRED at /llm/asr/sessions — server dictation never worked.
    const { verifyLiveModelGatewayToken } = await import("../src/services/model-gateway/auth.js");
    const live = await verifyLiveModelGatewayToken(asrOk.json().asrToken, "vision");
    assert.equal(live.ok, true, `the ASR token is accepted by the gateway's live check: ${JSON.stringify(live)}`);
    assert.equal(live.sessionId, desktopSessionId, "it is the desktop's session");
    await pool.query("update user_sessions set revoked_at = now() where id = $1", [desktopSessionId]);
    const loggedOut = await app.inject({ method: "POST", url: "/api/mobile/asr/token", payload: { deviceId: mobileDeviceId, grantId: directGrant, token: directToken } });
    assert.equal(loggedOut.statusCode, 409, "desktop logged out: no voice token");
    assert.equal(loggedOut.json().code, "DESKTOP_LOGIN_REQUIRED");
    await pool.query("update user_sessions set revoked_at = null where id = $1", [desktopSessionId]);
  }
  const asrBadDevice = await app.inject({ method: "POST", url: "/api/mobile/asr/token", payload: { deviceId: "dev_other_xxxx", grantId: directGrant, token: directToken } });
  assert.equal(asrBadDevice.statusCode, 403, "a mismatched device is refused an ASR token");

  // --- 11b. Web Push: the phone subscribes with its grant token; a desktop
  // frame worth waking it for, sent while no phone page is connected, becomes
  // a real push attempt (encrypted with the service's VAPID keys) — and a
  // frame the connected phone receives never does. ---
  {
    const b64u = (b) => Buffer.from(b).toString("base64url");
    const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
    const subscription = { endpoint: `https://127.0.0.1:9/push/${runId}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
    const pushBody = { deviceId: mobileDeviceId, grantId: directGrant, token: directToken };
    const key = await app.inject({ method: "POST", url: "/api/mobile/push/key", payload: pushBody });
    assert.equal(key.statusCode, 200, `push key: ${key.body}`);
    assert.ok(key.json().publicKey.length > 60, "a VAPID public key, generated on first use");
    const again = await app.inject({ method: "POST", url: "/api/mobile/push/key", payload: pushBody });
    assert.equal(again.json().publicKey, key.json().publicKey, "and kept");
    const forged = await app.inject({ method: "POST", url: "/api/mobile/push/subscribe", payload: { ...pushBody, token: "lily_mgrant_forged.token", subscription } });
    assert.equal(forged.statusCode, 401, "only the pairing's own token subscribes");
    const sub = await app.inject({ method: "POST", url: "/api/mobile/push/subscribe", payload: { ...pushBody, subscription } });
    assert.equal(sub.statusCode, 200, `subscribe: ${sub.body}`);
    const row = async () => (await pool.query("select failures, last_sent_at from mobile_push_subscriptions where grant_id = $1", [directGrant])).rows;
    assert.equal((await row()).length, 1);

    const desktopDirect = connectRelay(base, { role: "desktop", grantId: directGrant, deviceId: desktopDeviceId, token: desktopToken });
    await waitForFrame(desktopDirect, (f) => f.type === "relay.ready", "desktop joins the direct pairing");
    // Connected phone: it gets the frame; no push.
    const phoneOn = connectRelay(base, { role: "mobile", grantId: directGrant, deviceId: mobileDeviceId, token: directToken });
    await waitForFrame(phoneOn, (f) => f.type === "relay.ready", "phone connected");
    const got = waitForFrame(phoneOn, (f) => f.type === "turn.ended", "connected phone receives turn.ended");
    desktopDirect.send(JSON.stringify({ type: "turn.ended", turnId: "t_on", status: "completed" }));
    await got;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await row())[0].failures, 0, "a delivered frame is not also pushed");
    // Phone asleep: the same kind of frame becomes a push attempt (the endpoint refuses; the attempt is counted).
    const off = new Promise((r) => phoneOn.on("close", r));
    phoneOn.close();
    await off;
    await new Promise((r) => setTimeout(r, 200));
    desktopDirect.send(JSON.stringify({ type: "turn.ended", turnId: "t_off", status: "completed" }));
    const deadline = Date.now() + 8000;
    while ((await row())[0]?.failures !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await row())[0]?.failures, 1, "the undelivered frame was pushed (encrypted, sent, refused by the fake endpoint)");
    try { desktopDirect.close(); } catch { /* noop */ }
  }

  // --- 12. Token renewal (sliding) and revocation of a LIVE connection. ---
  const renewed = await app.inject({ method: "POST", url: "/api/mobile/grant/refresh", payload: { deviceId: mobileDeviceId, grantId: directGrant, token: directToken } });
  assert.equal(renewed.statusCode, 200, `refresh ok: ${renewed.body}`);
  assert.ok(renewed.json().mobileToken?.startsWith("lily_mgrant_") && renewed.json().expiresAt, "a paired phone renews its token");
  const renewedWs = connectRelay(base, { role: "mobile", grantId: directGrant, deviceId: mobileDeviceId, token: renewed.json().mobileToken });
  await waitForFrame(renewedWs, (f) => f.type === "relay.ready", "renewed token joins the relay");
  const renewedClosed = new Promise((resolve) => renewedWs.on("close", (code) => resolve(code)));
  const badRefresh = await app.inject({ method: "POST", url: "/api/mobile/grant/refresh", payload: { deviceId: mobileDeviceId, grantId: directGrant, token: "lily_mgrant_forged.token" } });
  assert.equal(badRefresh.statusCode, 401, "a forged token cannot renew");
  const revokeDirect = await desktopPost("/api/mobile/pairing/revoke", desktopBody({ grantId: directGrant, reason: "e2e" }));
  assert.equal(revokeDirect.statusCode, 200);
  const revokedCode = await Promise.race([renewedClosed, new Promise((r) => setTimeout(() => r("still-open"), 3000))]);
  assert.equal(revokedCode, 4001, "revoking kicks the phone's live connection immediately");
  {
    const deadline = Date.now() + 5000;
    const count = async () => Number((await pool.query("select count(*)::int n from mobile_push_subscriptions where grant_id = $1", [directGrant])).rows[0].n);
    while ((await count()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await count(), 0, "an ended pairing takes its push subscriptions with it");
  }
  const deadRefresh = await app.inject({ method: "POST", url: "/api/mobile/grant/refresh", payload: { deviceId: mobileDeviceId, grantId: directGrant, token: renewed.json().mobileToken } });
  assert.equal(deadRefresh.statusCode, 409, "a revoked pairing cannot renew");
  assert.equal(deadRefresh.json().code, "GRANT_INACTIVE");

  // --- 13. Protocol 2: the desktop's ONE control channel. The server pushes
  // every pairing change down it — nothing is polled. ---
  const channel = connectRelay(base, { role: "desktop", grantId: "", deviceId: desktopDeviceId, token: desktopToken });
  const channelFrames = [];
  channel.on("message", (d) => { try { channelFrames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  const hello = await waitForFrame(channel, (f) => f.type === "control.hello", "channel hello");
  assert.equal(hello.protocol, 2);
  assert.ok(Array.isArray(hello.grants) && Array.isArray(hello.pending), "hello carries the full state (reconnect = reconcile)");
  assert.ok(!hello.grants.some((g) => g.grantId === directGrant), "an ended pairing is not in the snapshot");

  // A phone scans → the desktop hears about it at once.
  const challenge3 = await desktopPost("/api/mobile/pairing/challenge", desktopBody({}));
  const pendingPushed = waitForFrame(channel, (f) => f.type === "control.pairing.pending", "pending pushed to the desktop");
  const consume3 = await app.inject({ method: "POST", url: "/api/mobile/pairing/consume", headers: { "user-agent": IPHONE_UA }, payload: { deviceId: mobileDeviceId, token: challenge3.json().token } });
  assert.equal(consume3.statusCode, 200);
  const grant3 = consume3.json().grantId;
  const pendingFrame = await pendingPushed;
  assert.equal(pendingFrame.grant.grantId, grant3);
  assert.equal(pendingFrame.grant.mobileLabel, "iPhone · Safari");

  // Approve → the pairing joins the live channel, pushed.
  const activePushed = waitForFrame(channel, (f) => f.type === "control.grant.active" && f.grant.grantId === grant3, "activation pushed");
  await desktopPost("/api/mobile/pairing/approve", desktopBody({ grantId: grant3 }));
  await activePushed;

  // The phone connects: the channel is told, and frames flow both ways, wrapped.
  const presencePushed = waitForFrame(channel, (f) => f.type === "control.presence" && f.grantId === grant3 && f.mobilesOnline === 1, "channel sees the phone");
  const phone3 = connectRelay(base, { role: "mobile", grantId: grant3, deviceId: mobileDeviceId, token: consume3.json().mobileToken });
  const phoneSeesDesktop = waitForFrame(phone3, (f) => f.type === "relay.presence" && f.desktopOnline === true, "phone sees the channel desktop");
  await Promise.all([presencePushed, phoneSeesDesktop]);
  const wrapped = waitForFrame(channel, (f) => f.type === "relay.frame" && f.grantId === grant3 && f.frame?.type === "command", "command arrives wrapped with its pairing");
  phone3.send(JSON.stringify({ type: "command", commandId: "cmd_ch_1", text: "经控制通道" }));
  assert.equal((await wrapped).frame.text, "经控制通道");
  const phoneGetsReply = waitForFrame(phone3, (f) => f.type === "assistant.delta", "phone receives the inner frame");
  channel.send(JSON.stringify({ type: "relay.frame", grantId: grant3, frame: { type: "assistant.delta", text: "收到" } }));
  assert.equal((await phoneGetsReply).text, "收到");

  // The channel cannot reach a pairing that is not its own.
  const refusedFrame = waitForFrame(channel, (f) => f.type === "relay.error", "unbound pairing refused");
  channel.send(JSON.stringify({ type: "relay.frame", grantId: grantId, frame: { type: "assistant.delta", text: "越权" } }));
  assert.equal((await refusedFrame).code, "RELAY_GRANT_NOT_BOUND");

  // Revoke → the channel is told, the phone is closed.
  const phone3Closed = new Promise((r) => phone3.on("close", (code) => r(code)));
  const endedPushed = waitForFrame(channel, (f) => f.type === "control.grant.ended" && f.grantId === grant3, "ending pushed");
  await desktopPost("/api/mobile/pairing/revoke", desktopBody({ grantId: grant3, reason: "user_action" }));
  assert.equal((await endedPushed).reason, "user_action");
  assert.equal(await phone3Closed, 4001);

  // Reconnecting the channel replaces the old one and re-sends the truth.
  const oldClosed = new Promise((r) => channel.on("close", (code) => r(code)));
  const channel2 = connectRelay(base, { role: "desktop", grantId: "", deviceId: desktopDeviceId, token: desktopToken });
  const hello2 = await waitForFrame(channel2, (f) => f.type === "control.hello", "second hello");
  assert.equal(await oldClosed, 4000, "the stale channel is replaced");
  assert.ok(!hello2.grants.some((g) => g.grantId === grant3), "the revoked pairing is gone from the snapshot");
  channel2.close();

  console.log("mobile-command-e2e: ok");
} finally {
  try { await app?.close(); } catch { /* noop */ }
  await pool.end();
}
