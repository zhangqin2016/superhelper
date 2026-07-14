#!/usr/bin/env node
// Mobile Command Phase 1 end-to-end integration smoke (no device, no DB).
//
// Strings together the REAL pieces built across Phase 1: the server WS relay,
// the desktop agent bridge, and the external-command admission decision — with
// a fake pairing auth and a fake session/queue. Proves the whole backend chain
// works together: mobile frame → relay → desktop bridge → admitExternalCommand
// → enqueue, and the admission ack projects back → mobile.
//
// Must run with cwd = server/ so fastify + ws resolve from server/node_modules.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// fastify + ws live in server/node_modules; a bare ESM import from scripts/
// won't find them, so resolve them through a server-rooted require.
const serverRequire = createRequire(path.join(ROOT, "server/package.json"));
const Fastify = serverRequire("fastify");
const { WebSocket } = serverRequire("ws");
const { registerMobileRelay } = await import(path.join(ROOT, "server/src/services/mobile-relay.js"));
const { createGrantToken } = await import(path.join(ROOT, "server/src/services/mobile-grant-token.js"));
const { decideExternalCommandAdmission, admissionResponse } = require(path.join(ROOT, "src/main/external-command-admission.js"));
const { createMobileAgentBridge } = require(path.join(ROOT, "src/main/mobile-agent-bridge.js"));

// --- fake orchestrator: real admission decision over an in-memory queue ------
const ledger = new Map();
const queue = [];
const fakeOrchestrator = {
  async admitExternalCommand(envelope) {
    const existing = ledger.get(envelope.commandId) || null;
    const d = decideExternalCommandAdmission({ envelope, existingRecord: existing, sessionExists: true, sessionOwned: true });
    if (["invalid", "payload_conflict", "session_absent", "ownership_mismatch"].includes(d.outcome)) {
      return { ok: false, code: d.code };
    }
    if (d.outcome === "idempotent_hit") return d.response;
    d.record.queueItemId = `q_${queue.length}`;
    ledger.set(d.record.commandId, d.record);
    queue.push({ commandId: envelope.commandId, text: envelope.text });
    return admissionResponse(d.record);
  },
};

// --- real relay with fake pairing auth --------------------------------------
const grant = { id: "g1", status: "active", user_id: "u1", desktop_device_id: "dtop", mobile_device_id: "dmob" };
const mobileToken = createGrantToken({ grantId: grant.id, mobileDeviceId: grant.mobile_device_id });
const app = Fastify({ logger: false });
registerMobileRelay(app, {
  verifyAccessToken: (t) => t === "tok_dtop" ? { ok: true, userId: "u1", sessionId: "s", deviceId: "dtop" }
                        : { ok: false, code: "BAD" },
  lookupActiveGrant: async (id) => (id === "g1" ? grant : null),
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
const relayBase = `ws://127.0.0.1:${port}/api/mobile/relay`;

// --- real desktop bridge: admit through the (fake) orchestrator --------------
const bridge = createMobileAgentBridge({
  relayUrl: relayBase,
  token: "tok_dtop",
  grantId: "g1",
  desktopDeviceId: "dtop",
  admit: (env) => fakeOrchestrator.admitExternalCommand(env),
  WebSocketCtor: WebSocket,
});
bridge.start();

// --- mobile client -----------------------------------------------------------
const mobile = new WebSocket(`${relayBase}?role=mobile&grantId=g1&deviceId=dmob&token=${encodeURIComponent(mobileToken)}`);
const mobileFrames = [];
mobile.on("message", (d) => { try { mobileFrames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((res, rej) => { mobile.on("open", res); mobile.on("error", rej); setTimeout(() => rej(new Error("mobile connect timeout")), 3000); });
await wait(150); // let the desktop bridge connect too

mobile.send(JSON.stringify({
  type: "command",
  commandId: "c_e2e_1",
  correlationId: "corr_e2e_1",
  idempotencyKey: "i_e2e_1",
  text: "端到端:帮我整理会议纪要",
  mobileDeviceId: "dmob",
  lilySessionId: "s1",
  mode: "queue",
}));
await wait(300);

// The command reached the desktop and was admitted into the session queue.
assert.equal(queue.length, 1, "the mobile command was admitted into the desktop session queue");
assert.equal(queue[0].commandId, "c_e2e_1");
assert.equal(queue[0].text, "端到端:帮我整理会议纪要", "the exact command text crossed the whole chain");

// The admission ack projected back to the mobile.
const ack = mobileFrames.find((f) => f.type === "command.admitted");
assert.ok(ack, "an admission ack was projected back to mobile");
assert.equal(ack.commandId, "c_e2e_1");
assert.equal(ack.correlationId, "corr_e2e_1", "the correlation id crosses mobile → desktop → mobile");
assert.equal(ack.effectiveMode, "queue");

// Idempotent replay: same command again admits no second queue item.
mobile.send(JSON.stringify({ type: "command", commandId: "c_e2e_1", idempotencyKey: "i_e2e_1", text: "端到端:帮我整理会议纪要", mobileDeviceId: "dmob", lilySessionId: "s1", mode: "queue" }));
await wait(250);
assert.equal(queue.length, 1, "a replayed command does not enqueue twice across the full chain");

bridge.stop();
mobile.close();
await app.close();
console.log("mobile-command-e2e: ok");
