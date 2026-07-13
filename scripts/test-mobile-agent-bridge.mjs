#!/usr/bin/env node
// Desktop agent bridge: relay command frame → admitExternalCommand → projection
// ack. Correctness-critical: it must admit through the sanctioned seam and
// forward the exact mode fields, never fabricate a command. Pure frame logic +
// injected admit; also a fake-WS lifecycle check.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  handleRelayCommandFrame,
  createMobileAgentBridge,
  payloadHashFor,
} = require(path.join(ROOT, "src/main/mobile-agent-bridge.js"));

// --- command frame → admit → admitted ack ------------------------------------
{
  let admitted = null;
  const { reply } = await handleRelayCommandFrame(
    JSON.stringify({ type: "command", commandId: "c1", idempotencyKey: "i1", text: "从手机发来的任务", mobileDeviceId: "dmob", lilySessionId: "s1", mode: "queue" }),
    { admit: async (env) => { admitted = env; return { ok: true, commandId: env.commandId, state: "admitted", requestedMode: env.mode, effectiveMode: "queue", downgradeReason: null }; }, desktopDeviceId: "dtop" },
  );
  assert.equal(admitted.commandId, "c1");
  assert.equal(admitted.desktopDeviceId, "dtop", "bridge stamps its own desktop device id");
  assert.equal(admitted.payloadHash, payloadHashFor("从手机发来的任务", []), "payload hash is computed over text+attachments");
  assert.equal(reply.type, "command.admitted");
  assert.equal(reply.commandId, "c1");
  assert.equal(reply.effectiveMode, "queue");
}

// --- steer downgrade fields forwarded ---------------------------------------
{
  const { reply } = await handleRelayCommandFrame(
    { type: "command", commandId: "c2", text: "hi", mobileDeviceId: "dmob", lilySessionId: "s1", mode: "steer" },
    { admit: async (env) => ({ ok: true, commandId: env.commandId, state: "admitted", requestedMode: "steer", effectiveMode: "queue", downgradeReason: "STEER_IDEMPOTENCY_UNAVAILABLE" }), desktopDeviceId: "dtop" },
  );
  assert.equal(reply.requestedMode, "steer");
  assert.equal(reply.effectiveMode, "queue");
  assert.equal(reply.downgradeReason, "STEER_IDEMPOTENCY_UNAVAILABLE", "mobile is told about the downgrade");
}

// --- rejected admission is forwarded, not silently dropped -------------------
{
  const { reply } = await handleRelayCommandFrame(
    { type: "command", commandId: "c3", text: "x", mobileDeviceId: "dmob", lilySessionId: "gone" },
    { admit: async () => ({ ok: false, code: "SESSION_ABSENT" }), desktopDeviceId: "dtop" },
  );
  assert.equal(reply.type, "command.rejected");
  assert.equal(reply.code, "SESSION_ABSENT");
}

// --- non-command frames ignored; malformed frames reported; empty rejected ---
{
  const ignored = await handleRelayCommandFrame({ type: "relay.ready" }, { admit: async () => { throw new Error("must not admit"); } });
  assert.equal(ignored.reply, null, "a non-command frame is ignored");
  const malformed = await handleRelayCommandFrame("{not json", { admit: async () => { throw new Error("no"); } });
  assert.equal(malformed.reply.code, "COMMAND_FRAME_MALFORMED");
  const empty = await handleRelayCommandFrame({ type: "command", commandId: "c4", text: "" }, { admit: async () => { throw new Error("no"); } });
  assert.equal(empty.reply.code, "COMMAND_INVALID", "a command with no text/attachments is rejected before admit");
}

// --- admit throwing is contained -------------------------------------------
{
  const { reply } = await handleRelayCommandFrame(
    { type: "command", commandId: "c5", text: "x", mobileDeviceId: "dmob", lilySessionId: "s1" },
    { admit: async () => { throw new Error("boom"); }, desktopDeviceId: "dtop" },
  );
  assert.equal(reply.type, "command.rejected");
  assert.equal(reply.code, "COMMAND_ADMISSION_ERROR");
}

// --- interrupt frame routes to the controlled interrupt seam ----------------
{
  let interrupted = false;
  const { reply } = await handleRelayCommandFrame(
    { type: "interrupt", turnId: "t9" },
    { admit: async () => { throw new Error("must not admit"); }, interrupt: async () => { interrupted = true; return { ok: true }; } },
  );
  assert.equal(interrupted, true, "interrupt frame calls the interrupt seam, not admit");
  assert.equal(reply.type, "interrupt.ack");
  assert.equal(reply.ok, true);
  assert.equal(reply.turnId, "t9");

  // no interrupt fn wired → graceful ack, never throws
  const noFn = await handleRelayCommandFrame({ type: "interrupt" }, { admit: async () => {} });
  assert.equal(noFn.reply.type, "interrupt.ack");
  assert.equal(noFn.reply.ok, false);
  assert.equal(noFn.reply.code, "INTERRUPT_UNAVAILABLE");

  // interrupt throwing is contained
  const boom = await handleRelayCommandFrame({ type: "interrupt" }, { interrupt: async () => { throw new Error("x"); } });
  assert.equal(boom.reply.type, "interrupt.ack");
  assert.equal(boom.reply.ok, false);
  assert.equal(boom.reply.code, "INTERRUPT_ERROR");
}

// --- bridge lifecycle against a fake WebSocket ------------------------------
{
  class FakeWS {
    static OPEN = 1;
    constructor(url) { FakeWS.last = this; this.url = url; this.readyState = 0; this.sent = []; }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { return this.onmessage?.({ data }); }
  }
  const admits = [];
  const bridge = createMobileAgentBridge({
    relayUrl: "ws://relay.example/api/mobile/relay",
    token: "tok", grantId: "g1", desktopDeviceId: "dtop",
    admit: async (env) => { admits.push(env); return { ok: true, commandId: env.commandId, state: "admitted", requestedMode: env.mode, effectiveMode: "queue", downgradeReason: null }; },
    WebSocketCtor: FakeWS,
  });
  bridge.start();
  const ws = FakeWS.last;
  assert.match(ws.url, /role=desktop/, "bridge connects as desktop");
  assert.match(ws.url, /grantId=g1/, "bridge connects for its grant");
  ws.open();
  assert.equal(bridge.isConnected(), true);
  await ws.message(JSON.stringify({ type: "command", commandId: "c9", text: "do it", mobileDeviceId: "dmob", lilySessionId: "s1" }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(admits.length, 1, "an inbound command is admitted");
  assert.equal(admits[0].commandId, "c9");
  const ack = JSON.parse(ws.sent.at(-1));
  assert.equal(ack.type, "command.admitted", "the ack is sent back to mobile");
  bridge.stop();
  assert.equal(bridge.isConnected(), false, "stop closes the connection");
}

console.log("mobile-agent-bridge: ok");
