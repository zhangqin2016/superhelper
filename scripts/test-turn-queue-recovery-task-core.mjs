#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { recoveredQueueOptions } = require("../src/main/turn-queue-recovery.js");
const { createQueueRecoveryEnvelope } = require("../src/main/turn-queue-recovery-envelope.js");
const { queueRecoveryEnvelope } = require("../src/main/turn-admission-runtime.js");

const sourceTaskCore = Object.freeze({
  schemaVersion: 1,
  taskId: "task-source",
  sessionId: "session-1",
  turnId: "turn-source",
  ownerScope: "account-1",
  fingerprint: "source-core-fingerprint",
  contract: { objective: "preserve this objective" },
  contextSnapshot: { sourceFingerprint: "source-context-fingerprint" },
});

const admitted = {
  sessionId: "session-1",
  turnId: "turn-retry",
  files: [],
  metadata: {
    queueRecovery: {
      schemaVersion: 2,
      kind: "durable_queue",
      queueItemId: "queue-retry",
      fileRefs: [],
      options: {
        sourceTurnId: "turn-source",
        queueOrigin: "recovery",
        requiredSuccessfulTools: ["artifact.verify"],
      },
    },
  },
};

const recovered = recoveredQueueOptions(admitted, (options) => options, sourceTaskCore);
assert.equal(recovered.options.sourceTurnId, "turn-source");
assert.equal(recovered.options.sourceTaskCore, sourceTaskCore);
assert.deepEqual(recovered.options.requiredSuccessfulTools, ["artifact.verify"]);

const envelope = createQueueRecoveryEnvelope({
  item: { id: "queue-retry", displayFiles: [] },
  options: { requiredSuccessfulTools: ["artifact.verify"] },
});
assert.deepEqual(envelope.options.requiredSuccessfulTools, ["artifact.verify"]);

const durable = queueRecoveryEnvelope({
  id: "queue-retry",
  displayFiles: [],
  options: { requiredSuccessfulTools: ["artifact.verify"], modelSelection: { mode: "auto", autoPoolMode: "custom", autoModelIds: ["original"] } },
});
assert.deepEqual(durable.options.requiredSuccessfulTools, ["artifact.verify"]);
assert.deepEqual(durable.options.modelSelection.autoModelIds, ["original"]);
assert.equal(durable.options.modelSelection.autoPoolMode, "custom");
const restored = recoveredQueueOptions({ ...admitted, metadata: { queueRecovery: JSON.parse(JSON.stringify(durable)) } }, value => value);
assert.deepEqual(restored.options.modelSelection.autoModelIds, ["original"]);

console.log("turn-queue-recovery-task-core: ok");
