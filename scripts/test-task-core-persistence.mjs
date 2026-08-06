#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { TURN_INPUT_MIGRATION_OWNED } = require("../src/main/store/turn-admission-migration.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-core-persistence-"));
const dbPath = path.join(root, "messages.db");
const blobDir = path.join(root, "blobs");
const sessionId = "session-task-core";
const ownerScope = "account:task-core";
const turnId = "turn-task-core";

function seed(store) {
  store.db.run(
    `INSERT INTO turn_inputs
       (session_id, admitted_seq, turn_id, delivery, status, user_text,
        files_json, metadata_json, created_at, owner_scope, migration_status)
     VALUES (?, 1, ?, 'direct', 'admitted', ?, '[]', '{}', ?, ?, ?)`,
    sessionId,
    turnId,
    "stable task",
    Date.now(),
    ownerScope,
    TURN_INPUT_MIGRATION_OWNED,
  );
}

const taskCore = Object.freeze({
  schemaVersion: 1,
  taskId: "task-core",
  sessionId,
  turnId,
  ownerScope,
  fingerprint: "sha256:task-core-fingerprint",
  contract: { objective: "stable task", status: "active" },
  contextSnapshot: { fingerprint: "sha256:context-fingerprint" },
});

let store = new MessageStore(dbPath, blobDir);
seed(store);
const first = store.persistTurnTaskCore({ sessionId, turnId, ownerScope, taskCore });
assert.equal(first.ok, true);
assert.equal(first.immutable, true);
assert.equal(store.getTurnInputByTurnId(turnId, ownerScope).taskCoreFingerprint, taskCore.fingerprint);
assert.equal(Object.isFrozen(store.getTurnInputByTurnId(turnId, ownerScope).taskCore), true);

const same = store.persistTurnTaskCore({ sessionId, turnId, ownerScope, taskCore });
assert.equal(same.ok, true);
assert.equal(same.idempotent, true);

const conflict = store.persistTurnTaskCore({
  sessionId,
  turnId,
  ownerScope,
  taskCore: { ...taskCore, fingerprint: "sha256:other" },
});
assert.equal(conflict.ok, false);
assert.equal(conflict.reason, "TASK_CORE_IMMUTABLE");

assert.equal(store.persistTurnTaskCore({
  sessionId,
  turnId,
  ownerScope: "account:other",
  taskCore,
}).reason, "NOT_FOUND");
store.close();

store = new MessageStore(dbPath, blobDir);
const restored = store.getTurnInputByTurnId(turnId, ownerScope);
assert.equal(restored.taskCoreFingerprint, taskCore.fingerprint);
assert.deepEqual(restored.taskCore.contract, taskCore.contract);
const taskResult = store.persistTaskResult({
  sessionId,
  ownerScope,
  taskId: "task-core",
  turnId,
  attemptId: "attempt-1",
  terminalType: "turn.completed",
  verification: { status: "verified", reason: "test" },
});
assert.equal(taskResult.ok, true);
assert.equal(store.markTaskResultDelivered({
  sessionId,
  ownerScope,
  turnId,
  delivery: { emitted: true, archived: true },
}).ok, true);
assert.equal(store.getTaskResult(sessionId, ownerScope, turnId).deliveryStatus, "delivered");
store.close();

console.log("task-core-persistence: ok");
