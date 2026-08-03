#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const {
  RuntimeCheckpointStore,
  migrateRuntimeCheckpointSchema,
} = require("../src/main/store/runtime-checkpoint-store.js");

const db = openDatabase(":memory:");
try {
  migrateRuntimeCheckpointSchema(db);
  const store = new RuntimeCheckpointStore(db, { now: () => 100 });
  const prepared = store.prepare({
    id: "cp-1",
    sessionId: "s1",
    turnId: "t1",
    taskRunId: "task-1",
    engineSessionId: "engine-1",
    engineMessageId: "message-1",
    kind: "turn",
    components: [{ type: "files", refId: "diff-1", version: 1, hash: "a".repeat(64), reversible: true }],
    effects: [{ tool: "shell", refId: "call-1", reversible: false, status: "completed" }],
    createdAt: 100,
  });
  assert.equal(store.get("cp-1", "s1").status, "preparing");
  assert.throws(() => store.commit("cp-1", "s1", "wrong"), /RUNTIME_CHECKPOINT_INTEGRITY_MISMATCH/);
  const committed = store.commit("cp-1", "s1", prepared.integrityHash);
  assert.equal(committed.status, "committed");
  assert.equal(store.commit("cp-1", "s1", prepared.integrityHash).status, "committed", "commit is idempotent");
  assert.throws(() => store.get("cp-1", "s2"), /RUNTIME_CHECKPOINT_SCOPE_MISMATCH/);

  const safety = store.beginRestore("cp-1", "s1", { id: "restore-1", createdAt: 110 });
  assert.equal(safety.restore.status, "restoring");
  assert.equal(safety.safetyCheckpoint.parentCheckpointId, "cp-1");
  assert.equal(safety.plan.unresolvedEffects.length, 1);
  assert.equal(store.completeRestore("restore-1", "s1", { unresolvedEffects: safety.plan.unresolvedEffects, completedAt: 120 }).status, "restored");

  const fork = store.fork("cp-1", "s1", { id: "cp-fork", sessionId: "s-fork", turnId: "t-fork", createdAt: 130 });
  assert.equal(fork.parentCheckpointId, "cp-1");
  assert.equal(fork.sessionId, "s-fork");
  assert.equal(store.get("cp-1", "s1").sessionId, "s1", "fork never mutates the source checkpoint");
} finally {
  db.close();
}

console.log("runtime-checkpoint-store: ok");
