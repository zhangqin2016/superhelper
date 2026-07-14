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
  MAX_ATTACHMENTS,
  payloadHashFor,
} = require(path.join(ROOT, "src/main/mobile-agent-bridge.js"));

// --- command frame → admit → admitted ack ------------------------------------
{
  let admitted = null;
  const { reply } = await handleRelayCommandFrame(
    JSON.stringify({ type: "command", commandId: "c1", correlationId: "corr-c1", idempotencyKey: "i1", text: "从手机发来的任务", mobileDeviceId: "dmob", lilySessionId: "s1", mode: "queue" }),
    { admit: async (env) => { admitted = env; return { ok: true, commandId: env.commandId, correlationId: env.correlationId, state: "admitted", requestedMode: env.mode, effectiveMode: "queue", downgradeReason: null }; }, desktopDeviceId: "dtop" },
  );
  assert.equal(admitted.commandId, "c1");
  assert.equal(admitted.correlationId, "corr-c1", "bridge forwards the mobile correlation id");
  assert.equal(admitted.desktopDeviceId, "dtop", "bridge stamps its own desktop device id");
  assert.equal(admitted.payloadHash, payloadHashFor("从手机发来的任务", []), "payload hash is computed over text+attachments");
  assert.equal(reply.type, "command.admitted");
  assert.equal(reply.commandId, "c1");
  assert.equal(reply.correlationId, "corr-c1", "ack carries the same correlation id");
  assert.equal(reply.effectiveMode, "queue");
}

// --- correlation id falls back to commandId for old mobile clients ----------
{
  let admitted = null;
  const { reply } = await handleRelayCommandFrame(
    { type: "command", commandId: "legacy-c1", text: "旧客户端", mobileDeviceId: "dmob", lilySessionId: "s1" },
    { admit: async (env) => { admitted = env; return { ok: true, commandId: env.commandId, correlationId: env.correlationId, state: "admitted", requestedMode: env.mode, effectiveMode: "queue", downgradeReason: null }; }, desktopDeviceId: "dtop" },
  );
  assert.equal(admitted.correlationId, "legacy-c1", "old clients get commandId as correlation id");
  assert.equal(reply.correlationId, "legacy-c1");
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
    { type: "command", commandId: "c3", correlationId: "corr-c3", text: "x", mobileDeviceId: "dmob", lilySessionId: "gone" },
    { admit: async () => ({ ok: false, code: "SESSION_ABSENT" }), desktopDeviceId: "dtop" },
  );
  assert.equal(reply.type, "command.rejected");
  assert.equal(reply.correlationId, "corr-c3");
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

// --- unsupported protocol / oversized payloads rejected before admission -----
{
  let admitCalls = 0;
  const unsupported = await handleRelayCommandFrame(
    { type: "command", protocolVersion: 2, commandId: "proto2", text: "x" },
    { admit: async () => { admitCalls += 1; } },
  );
  assert.equal(unsupported.reply.type, "command.rejected");
  assert.equal(unsupported.reply.code, "CLIENT_UPGRADE_REQUIRED");
  assert.equal(admitCalls, 0, "unsupported protocol is rejected before admission");

  const oversized = await handleRelayCommandFrame(
    { type: "command", commandId: "too-long", text: "x".repeat(8001) },
    { admit: async () => { admitCalls += 1; } },
  );
  assert.equal(oversized.reply.code, "COMMAND_TEXT_TOO_LARGE");
  assert.equal(admitCalls, 0, "oversized text is rejected instead of silently truncated");

  const tooManyAttachments = await handleRelayCommandFrame(
    { type: "command", commandId: "too-many", text: "x", attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `${i}.jpg`, mimeType: "image/jpeg", dataBase64: "eA==" })) },
    { admit: async () => { admitCalls += 1; } },
  );
  assert.equal(tooManyAttachments.reply.code, "ATTACHMENT_COUNT_EXCEEDED");
  assert.equal(admitCalls, 0, "too many attachments is rejected before materialization/admission");
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
  let interruptRequest = null;
  const { reply } = await handleRelayCommandFrame(
    { type: "interrupt", turnId: "t9", correlationId: "corr-stop-1" },
    { admit: async () => { throw new Error("must not admit"); }, interrupt: async (req) => { interrupted = true; interruptRequest = req; return { ok: true }; } },
  );
  assert.equal(interrupted, true, "interrupt frame calls the interrupt seam, not admit");
  assert.equal(interruptRequest.correlationId, "corr-stop-1", "interrupt seam receives the correlation id");
  assert.equal(reply.type, "interrupt.ack");
  assert.equal(reply.ok, true);
  assert.equal(reply.turnId, "t9");
  assert.equal(reply.correlationId, "corr-stop-1");

  // no interrupt fn wired → graceful ack, never throws
  const noFn = await handleRelayCommandFrame({ type: "interrupt", correlationId: "corr-stop-missing" }, { admit: async () => {} });
  assert.equal(noFn.reply.type, "interrupt.ack");
  assert.equal(noFn.reply.ok, false);
  assert.equal(noFn.reply.correlationId, "corr-stop-missing");
  assert.equal(noFn.reply.code, "INTERRUPT_UNAVAILABLE");

  // interrupt throwing is contained
  const boom = await handleRelayCommandFrame({ type: "interrupt" }, { interrupt: async () => { throw new Error("x"); } });
  assert.equal(boom.reply.type, "interrupt.ack");
  assert.equal(boom.reply.ok, false);
  assert.equal(boom.reply.code, "INTERRUPT_ERROR");
}

// --- attachments materialize into envelope.files (fail-open) ----------------
{
  let envSeen = null;
  const materializeAttachments = async (atts) => atts.map((a, i) => ({ path: `/tmp/${i}_${a.name}`, name: a.name }));
  await handleRelayCommandFrame(
    { type: "command", commandId: "cA", text: "看图", attachments: [{ name: "p.jpg", mimeType: "image/jpeg", dataBase64: "eA==" }], mobileDeviceId: "dmob", lilySessionId: "s1" },
    { admit: async (env) => { envSeen = env; return { ok: true, commandId: env.commandId, state: "admitted", requestedMode: "queue", effectiveMode: "queue", downgradeReason: null }; }, materializeAttachments, desktopDeviceId: "dtop" },
  );
  assert.equal(envSeen.files.length, 1, "attachments become envelope.files (real paths for the turn)");
  assert.equal(envSeen.files[0].path, "/tmp/0_p.jpg");
  assert.equal(envSeen.attachmentStatus, "attached", "admitted envelope records attachment status");

  // materialize throwing → text-only, still admits (fail-open)
  let envSeen2 = null;
  const r2 = await handleRelayCommandFrame(
    { type: "command", commandId: "cB", text: "看图", attachments: [{ name: "p.jpg", mimeType: "image/jpeg", dataBase64: "eA==" }], mobileDeviceId: "dmob", lilySessionId: "s1" },
    { admit: async (env) => { envSeen2 = env; return { ok: true, commandId: env.commandId, state: "admitted", requestedMode: "queue", effectiveMode: "queue", downgradeReason: null }; }, materializeAttachments: async () => { throw new Error("x"); }, desktopDeviceId: "dtop" },
  );
  assert.deepEqual(envSeen2.files, [], "materialize failure → text-only, no throw");
  assert.equal(envSeen2.attachmentStatus, "dropped", "materialization failure is visible in the envelope");
  assert.equal(r2.reply.type, "command.admitted", "command still admits without attachments");
  assert.equal(r2.reply.attachmentStatus, "dropped", "mobile ack says the image was dropped");
  assert.equal(r2.reply.attachmentCount, 1);
  assert.equal(r2.reply.materializedFileCount, 0);

  // partial materialization is visible too
  let envSeen3 = null;
  const r3 = await handleRelayCommandFrame(
    { type: "command", commandId: "cC", text: "看两张图", attachments: [{ name: "a.jpg", mimeType: "image/jpeg", dataBase64: "YQ==" }, { name: "b.jpg", mimeType: "image/jpeg", dataBase64: "Yg==" }], mobileDeviceId: "dmob", lilySessionId: "s1" },
    { admit: async (env) => { envSeen3 = env; return { ok: true, commandId: env.commandId, state: "admitted", requestedMode: "queue", effectiveMode: "queue", downgradeReason: null }; }, materializeAttachments: async () => [{ path: "/tmp/a.jpg", name: "a.jpg" }], desktopDeviceId: "dtop" },
  );
  assert.equal(envSeen3.attachmentStatus, "partial");
  assert.equal(r3.reply.attachmentStatus, "partial");
  assert.equal(r3.reply.attachmentCount, 2);
  assert.equal(r3.reply.materializedFileCount, 1);
}

// --- session.request returns the desktop-provided context ------------------
{
  const ctxFrame = { type: "session.context", title: "s", sessionId: "s1", phase: "idle", queueLength: 0, recent: [] };
  const { reply } = await handleRelayCommandFrame(
    { type: "session.request" },
    { getSessionContext: async () => ctxFrame },
  );
  assert.deepEqual(reply, ctxFrame, "session.request replies with the built context");

  // no provider / throw → no reply, never breaks
  const none = await handleRelayCommandFrame({ type: "session.request" }, {});
  assert.equal(none.reply, null);
  const threw = await handleRelayCommandFrame({ type: "session.request" }, { getSessionContext: async () => { throw new Error("x"); } });
  assert.equal(threw.reply, null);
}

// --- sessions.request + session.select expose explicit mobile target choice -
{
  const sessionList = {
    type: "sessions.list",
    activeSessionId: "s1",
    selectedSessionId: "s2",
    sessions: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }],
  };
  const listReply = await handleRelayCommandFrame(
    { type: "sessions.request" },
    { getSessionList: async () => sessionList },
  );
  assert.deepEqual(listReply.reply, sessionList, "sessions.request replies with selectable sessions");

  let selectedId = "";
  const selectedContext = { type: "session.context", title: "B", sessionId: "s2", phase: "idle", queueLength: 0, recent: [] };
  const selectReply = await handleRelayCommandFrame(
    { type: "session.select", sessionId: "s2" },
    {
      selectSession: async (sessionId) => {
        selectedId = sessionId;
        return selectedContext;
      },
    },
  );
  assert.equal(selectedId, "s2", "session.select passes the target id to the desktop selector");
  assert.deepEqual(selectReply.reply, selectedContext, "session.select returns the selected session context");

  const missingSelector = await handleRelayCommandFrame({ type: "session.select", sessionId: "s2" }, {});
  assert.deepEqual(missingSelector.reply, { type: "session.select.ack", ok: false, sessionId: "s2", code: "SESSION_SELECT_UNAVAILABLE" });
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
