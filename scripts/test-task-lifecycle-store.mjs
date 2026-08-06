#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-lifecycle-store-"));
const store = new MessageStore(path.join(root, "messages.db"), path.join(root, "blobs"));
const identity = {
  sessionId: "session-lifecycle",
  ownerScope: "account:lifecycle",
  taskId: "task-lifecycle",
  turnId: "turn-lifecycle",
};

const created = store.ensureTaskLifecycle({ ...identity, taskCoreFingerprint: "sha256:core" });
assert.equal(created.ok, true);
assert.equal(created.idempotent, false);
assert.equal(created.lifecycle.status, "admitted");

const same = store.ensureTaskLifecycle({ ...identity, taskCoreFingerprint: "sha256:core" });
assert.equal(same.ok, true);
assert.equal(same.idempotent, true);

const conflict = store.ensureTaskLifecycle({ ...identity, taskCoreFingerprint: "sha256:other" });
assert.equal(conflict.ok, false);
assert.equal(conflict.reason, "TASK_LIFECYCLE_IMMUTABLE");

const running = store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["admitted"],
  status: "running",
  graphId: "graph-lifecycle",
  attemptId: "attempt-lifecycle",
  processJobId: "job-lifecycle",
  expectedVersion: 0,
});
assert.equal(running.ok, true);
assert.equal(running.lifecycle.version, 1);
assert.equal(running.lifecycle.graphId, "graph-lifecycle");
assert.equal(running.lifecycle.processJobId, "job-lifecycle");

const stale = store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["running"],
  status: "verifying",
  expectedVersion: 0,
});
assert.equal(stale.ok, false);
assert.equal(stale.reason, "TASK_LIFECYCLE_VERSION_CONFLICT");

const illegal = store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["running"],
  status: "delivered",
  expectedVersion: 1,
});
assert.equal(illegal.ok, false);
assert.equal(illegal.reason, "TASK_LIFECYCLE_TRANSITION_INVALID");

const verifying = store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["running"],
  status: "verifying",
  expectedVersion: 1,
});
assert.equal(verifying.ok, true);

const verified = store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["verifying"],
  status: "verified",
  verification: { status: "verified", reason: "tests" },
  expectedVersion: 2,
});
assert.equal(verified.ok, true);
assert.equal(verified.lifecycle.verification.status, "verified");

const delivered = store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["verified"],
  status: "delivered",
  delivery: { messageId: "message-lifecycle" },
  expectedVersion: 3,
});
assert.equal(delivered.ok, true);
assert.equal(delivered.lifecycle.status, "delivered");
assert.equal(delivered.lifecycle.deliveryStatus, "delivered");

assert.equal(store.transitionTaskLifecycle({
  ...identity,
  fromStatuses: ["delivered"],
  status: "running",
  expectedVersion: 4,
}).reason, "TASK_LIFECYCLE_TRANSITION_INVALID");

const outcomeRoot = "account:lifecycle-outcome";
const outcome = store.ensureTaskLifecycle({
  sessionId: "session-outcome",
  ownerScope: outcomeRoot,
  taskId: "task-outcome",
  turnId: "turn-outcome",
});
assert.equal(outcome.ok, true);
assert.equal(store.transitionTaskLifecycle({
  sessionId: "session-outcome",
  ownerScope: outcomeRoot,
  taskId: "task-outcome",
  turnId: "turn-outcome",
  status: "running",
}).ok, true);
assert.equal(store.transitionTaskLifecycle({
  sessionId: "session-outcome",
  ownerScope: outcomeRoot,
  taskId: "task-outcome",
  turnId: "turn-outcome",
  status: "outcome_unknown",
}).ok, true);
const outcomeDelivered = store.markTaskLifecycleDelivered({
  sessionId: "session-outcome",
  ownerScope: outcomeRoot,
  taskId: "task-outcome",
  turnId: "turn-outcome",
  delivery: { recoveryRequired: true },
});
assert.equal(outcomeDelivered.ok, true);
assert.equal(outcomeDelivered.lifecycle.status, "outcome_unknown");
assert.equal(outcomeDelivered.lifecycle.deliveryStatus, "delivered");

assert.equal(store.getTaskLifecycle(identity.sessionId, identity.ownerScope, identity.turnId).status, "delivered");
assert.equal(store.getTaskLifecycle(identity.sessionId, "account:other", identity.turnId), null);

store.close();
console.log("task-lifecycle-store: ok");
