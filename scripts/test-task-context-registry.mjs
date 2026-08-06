#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { createContextSnapshot } = require("../src/main/task-core-contracts.js");
const { registryId, replayabilityFor } = require("../src/main/store/task-context-registry-store.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-context-registry-"));
const store = new MessageStore(path.join(root, "messages.db"), path.join(root, "blobs"));
const snapshot = Object.freeze({
  schemaVersion: 1,
  sessionId: "session-context",
  taskId: "task-context",
  turnId: "turn-context",
  sourceFingerprint: "sha256:context-source",
  sources: {
    projectId: "project-context",
    files: [{ path: "/tmp/report.txt", size: 12, modifiedAt: 100, contentHash: "sha256:" + "a".repeat(64) }],
  },
});
const id = registryId({
  sessionId: "session-context",
  ownerScope: "account:context",
  taskId: "task-context",
  turnId: "turn-context",
  sourceFingerprint: snapshot.sourceFingerprint,
});
const first = store.persistTaskContextSnapshot({
  registryId: id,
  sessionId: "session-context",
  ownerScope: "account:context",
  taskId: "task-context",
  turnId: "turn-context",
  snapshot,
});
assert.equal(first.ok, true);
assert.equal(first.context.registryId, id);
assert.equal(first.context.replayability.mode, "revalidate");
assert.deepEqual(first.context.replayability.reasons, ["PATH_BACKED_SOURCE"]);

const same = store.persistTaskContextSnapshot({
  registryId: id,
  sessionId: "session-context",
  ownerScope: "account:context",
  taskId: "task-context",
  turnId: "turn-context",
  snapshot,
});
assert.equal(same.ok, true);
assert.equal(same.idempotent, true);

const conflict = store.persistTaskContextSnapshot({
  registryId: id,
  sessionId: "session-context",
  ownerScope: "account:context",
  taskId: "task-context",
  turnId: "turn-context",
  snapshot: { ...snapshot, sourceFingerprint: "sha256:changed" },
});
assert.equal(conflict.ok, false);
assert.equal(conflict.reason, "TASK_CONTEXT_IMMUTABLE");

const restored = store.getTaskContextSnapshot("session-context", "account:context", "turn-context");
assert.equal(restored.snapshot.sourceFingerprint, snapshot.sourceFingerprint);
assert.equal(replayabilityFor({ sources: { files: [{ path: "/tmp/large.bin" }] } }).mode, "revalidate");
assert.equal(replayabilityFor({ sources: { files: [{ contentRef: "blob:report" }] } }).mode, "exact");
const exactSnapshot = createContextSnapshot({
  sessionId: "session-context",
  admission: { sessionId: "session-context", turnId: "turn-exact", ownerScope: "account:context" },
  files: [{ blobId: "blob:report", size: 12 }],
});
assert.equal(exactSnapshot.sources.files[0].contentRef, "blob:report");
assert.equal(replayabilityFor(exactSnapshot).mode, "exact");
assert.equal(store.getTaskContextSnapshot("session-context", "account:other", "turn-context"), null);
store.close();
console.log("task-context-registry: ok");
