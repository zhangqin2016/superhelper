#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "parent-closure-persistence-"));
const dbPath = path.join(root, "messages.db");
const blobDir = path.join(root, "blobs");
const identity = {
  sessionId: "session-parent-closure",
  ownerScope: "account:parent-closure",
  sourceTurnId: "turn-parent-source",
  recoveryKey: "parent-closure:session-parent-closure:turn-parent-source",
};
const source = {
  objective: "完成安装包并验证",
  files: [{ path: "/tmp/package.pkg" }],
  taskContract: {
    active: true,
    taskType: "code_change",
    categories: ["release"],
    intentContract: { objective: "完成安装包并验证" },
  },
  evidence: {
    done: [{ id: "tool-1", name: "bash", status: "done", label: "构建" }],
    failed: [],
    running: [],
  },
  taskCore: { fingerprint: "sha256:source-core", taskId: "task-parent" },
};

let store = new MessageStore(dbPath, blobDir);
const prepared = store.prepareParentClosureRecovery({ ...identity, source });
assert.equal(prepared.ok, true);
assert.equal(prepared.created, true);
assert.match(prepared.recovery.recoveryTurnId, /^turn_parent_closure_/);

const same = store.prepareParentClosureRecovery({ ...identity, source });
assert.equal(same.ok, true);
assert.equal(same.idempotent, true);
assert.equal(same.recovery.recoveryTurnId, prepared.recovery.recoveryTurnId);

const claimed = store.claimParentClosureRecovery({ ...identity, now: 10_000 });
assert.equal(claimed.ok, true);
assert.equal(claimed.claimed, true);
assert.equal(claimed.recovery.status, "claimed");

const duplicateClaim = store.claimParentClosureRecovery({ ...identity, now: 10_001 });
assert.equal(duplicateClaim.ok, false);
assert.equal(duplicateClaim.reason, "ALREADY_CLAIMED");

const restartPending = store.listPendingParentClosureRecoveries(
  identity.sessionId,
  identity.ownerScope,
  200_000,
);
assert.equal(restartPending.length, 1, "an expired claim is recoverable after restart");
assert.equal(restartPending[0].recoveryTurnId, prepared.recovery.recoveryTurnId);

const dispatched = store.markParentClosureRecoveryDispatched({
  ...identity,
  recoveryTurnId: prepared.recovery.recoveryTurnId,
  claimToken: claimed.claimToken,
  now: 10_002,
});
assert.equal(dispatched.ok, true);
assert.equal(dispatched.recovery.status, "dispatched");

store.close();
store = new MessageStore(dbPath, blobDir);
const restored = store.getParentClosureRecovery(identity.sessionId, identity.sourceTurnId, identity.ownerScope);
assert.equal(restored.status, "dispatched");
assert.equal(restored.recoveryTurnId, prepared.recovery.recoveryTurnId);
assert.deepEqual(restored.source.taskContract.intentContract, source.taskContract.intentContract);
assert.equal(store.claimParentClosureRecovery({ ...identity, now: 10_003 }).reason, "ALREADY_DISPATCHED");
store.close();

console.log("parent-task-closure-persistence: ok");
