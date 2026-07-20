#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createExternalCommandRuntime } = require("../src/main/external-command-runtime.js");

const state = { queue: [] };
const queueEmits = [];
const dispatches = [];
let queueSequence = 0;
const runtime = createExternalCommandRuntime({
  ledgerStore: {
    loadSync() { throw new Error("corrupted ledger"); },
    scheduleFlush() { throw new Error("must not overwrite a corrupted ledger"); },
  },
  findSession: (sessionId) => sessionId === "session_1" ? { id: sessionId } : null,
  getState: () => state,
  createQueueId: () => `queue_${++queueSequence}`,
  buildQueueOptions: (value) => ({ ...value, normalized: true }),
  emitQueue: (sessionId) => queueEmits.push(sessionId),
  dispatchNext: (sessionId) => dispatches.push(sessionId),
});

const envelope = {
  commandId: "command_1",
  idempotencyKey: "idempotency_1",
  payloadHash: "payload_1",
  lilySessionId: "session_1",
  mobileDeviceId: "mobile_1",
  remoteSessionId: "remote_1",
  text: "Run the queued task",
  mode: "queue",
};

const admitted = await runtime.admit(envelope);
assert.equal(admitted.ok, true, "corrupted durable state falls back to in-memory admission");
assert.equal(state.queue.length, 1);
assert.equal(state.queue[0].options.queueOrigin, "mobile_command");
assert.equal(state.queue[0].options.normalized, true);
assert.equal(state.queue[0].options.externalCommand.commandId, "command_1");
assert.deepEqual(queueEmits, ["session_1"]);
assert.deepEqual(dispatches, ["session_1"]);

const replay = await runtime.admit(envelope);
assert.equal(replay.ok, true);
assert.equal(state.queue.length, 1, "in-memory fallback still preserves exactly-once admission");

const absent = await runtime.admit({
  ...envelope,
  commandId: "command_absent",
  idempotencyKey: "idempotency_absent",
  payloadHash: "payload_absent",
  lilySessionId: "missing",
});
assert.equal(absent.ok, false);
assert.equal(absent.code, "SESSION_ABSENT");

const brokenStateRuntime = createExternalCommandRuntime({
  ledgerStore: { loadSync: () => new Map(), scheduleFlush: () => {} },
  findSession: () => ({ id: "session_1" }),
  getState: () => { throw new Error("state unavailable"); },
});
const failedOpen = await brokenStateRuntime.admit(envelope);
assert.deepEqual(failedOpen, { ok: false, code: "COMMAND_ADMISSION_ERROR" });

console.log("external-command-runtime: ok");
