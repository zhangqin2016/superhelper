#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createRuntimeCheckpointManifest,
  restorePlanForCheckpoint,
  verifyRuntimeCheckpointManifest,
} = require("../src/main/runtime-checkpoint.js");

const manifest = createRuntimeCheckpointManifest({
  id: "checkpoint-1",
  sessionId: "session-1",
  turnId: "turn-1",
  taskRunId: "task-1",
  engineSessionId: "engine-1",
  engineMessageId: "message-1",
  kind: "turn",
  createdAt: 100,
  components: [
    { type: "files", refId: "diff-turn-1", version: 1, hash: "a".repeat(64), reversible: true },
    { type: "agent_graph", refId: "graph-1", version: 3, hash: "b".repeat(64), reversible: true },
  ],
  effects: [
    { tool: "mail_send", refId: "mail-1", reversible: false, status: "completed" },
  ],
});
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.integrityHash.length, 64);
assert.equal(verifyRuntimeCheckpointManifest(manifest).ok, true);

const reordered = createRuntimeCheckpointManifest({
  ...manifest,
  integrityHash: undefined,
  components: [...manifest.components].reverse(),
});
assert.equal(reordered.integrityHash, manifest.integrityHash, "canonical ordering is deterministic");

assert.equal(
  verifyRuntimeCheckpointManifest({ ...manifest, turnId: "tampered" }).ok,
  false,
  "tampering is detected",
);
assert.throws(
  () => createRuntimeCheckpointManifest({ ...manifest, components: [{ type: "files", refId: "x", hash: "bad" }] }),
  /RUNTIME_CHECKPOINT_COMPONENT_INVALID/,
);

const plan = restorePlanForCheckpoint(manifest);
assert.deepEqual(plan.reversibleComponents.map((item) => item.type), ["agent_graph", "files"]);
assert.equal(plan.unresolvedEffects.length, 1);
assert.equal(plan.unresolvedEffects[0].tool, "mail_send");
assert.equal(plan.requiresConfirmation, true);

console.log("runtime-checkpoint: ok");
