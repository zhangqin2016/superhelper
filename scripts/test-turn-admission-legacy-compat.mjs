#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createTurnAdmissionMethods,
} = require("../src/main/turn-admission-runtime.js");

const warnings = [];
let turnSequence = 0;
const methods = createTurnAdmissionMethods({
  log: {
    warn(...args) {
      warnings.push(args);
    },
  },
  mergeDisplayFileMetadata: (files) => files || [],
  newQueueId: () => "queue_legacy",
  newTurnId: () => `turn_legacy_${++turnSequence}`,
  queueDispatchOptions: (value) => value,
});
const session = { id: "legacy_session" };
const legacyAdapter = {
  ctx: {
    sessionManager: {
      findById: () => session,
    },
  },
  _state: () => ({ phase: "idle", queue: [] }),
  _emitQueue: () => {},
  _dispatchNext: () => {},
};
Object.assign(legacyAdapter, methods);

const direct = legacyAdapter._admitTurnInput(session, {
  turnId: "turn_legacy_direct",
  delivery: "direct",
  status: "admitted",
  userText: "keep the strong native direct path",
  files: [],
  metadata: { callerValue: true },
  createdAt: 123,
});
assert.equal(direct.turnId, "turn_legacy_direct");
assert.equal(direct.delivery, "direct");
assert.equal(direct.status, "admitted");
assert.equal(direct.legacyEphemeral, true);
assert.equal(direct.admissionMode, "legacy_ephemeral_native");
assert.equal(
  Object.hasOwn(direct.metadata, "characterWorlds"),
  false,
  "legacy compatibility remains native and cannot fabricate a character snapshot",
);

const local = legacyAdapter._admitTurnInput(session, {
  turnId: "turn_legacy_local",
  delivery: "local",
  userText: "local adapter path",
  metadata: {},
});
assert.equal(local.legacyEphemeral, true);
assert.equal(local.admissionMode, "legacy_ephemeral_native");
assert.ok(warnings.length >= 1, "legacy fallback is observable in logs");

assert.throws(
  () => legacyAdapter._admitTurnInput(session, {
    turnId: "turn_legacy_source",
    delivery: "direct",
    sourceTurnId: "turn_source",
  }),
  (error) => error?.code === "TURN_ADMISSION_FAILED",
  "source snapshot inheritance cannot fall back to an untrusted ephemeral admission",
);

const queueItem = {
  id: "queue_legacy_durable",
  text: "durable queue still requires admission",
  files: [],
  displayFiles: [],
  options: {},
};
const queued = legacyAdapter._admitQueuedTurn(session, queueItem);
assert.equal(queued.ok, false);
assert.equal(queued.error, "TURN_ADMISSION_FAILED");
assert.equal(
  queued.subcode,
  "ADMISSION_CAPABILITY_UNAVAILABLE",
  "scheduled, external, and durable queue paths must not inherit direct-path compatibility",
);

console.log("turn-admission-legacy-compat: ok");
