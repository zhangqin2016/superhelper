#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  addAgentTask,
  cancelAgentTask,
  claimReadyTask,
  completeAgentTask,
  createAgentTaskGraph,
  expireAgentTaskLeases,
  failAgentTask,
  renewAgentTaskLease,
} = require("../src/main/agent-task-graph.js");

const graph = createAgentTaskGraph({
  id: "graph-1",
  taskRunId: "run-1",
  sessionId: "session-1",
  principalId: "owner-1",
  maxConcurrency: 2,
  now: 1,
});
addAgentTask(graph, { id: "collect", objective: "Collect evidence", replaySafe: true, maxAttempts: 2 });
addAgentTask(graph, { id: "summarize", objective: "Summarize evidence", dependsOn: ["collect"] });
assert.equal(graph.tasks.collect.status, "ready");
assert.equal(graph.tasks.summarize.status, "blocked");

assert.throws(
  () => addAgentTask(graph, { id: "cycle", objective: "Cycle", dependsOn: ["missing"] }),
  /AGENT_TASK_DEPENDENCY_NOT_FOUND/,
);
assert.throws(
  () => addAgentTask(graph, { id: "self", objective: "Self", dependsOn: ["self"] }),
  /AGENT_TASK_SELF_DEPENDENCY/,
);
assert.throws(
  () => addAgentTask(graph, { id: "nested", objective: "Nested", depth: 2 }),
  /AGENT_TASK_DEPTH_EXCEEDED/,
);

const claim = claimReadyTask(graph, { workerId: "worker-1", now: 10, leaseMs: 100 });
assert.equal(claim.taskId, "collect");
assert.equal(graph.tasks.collect.status, "running");
assert.equal(claimReadyTask(graph, { workerId: "worker-2", now: 11, leaseMs: 100 }), null);
const renewed = renewAgentTaskLease(graph, "collect", { attemptId: claim.attemptId, workerId: "worker-1", now: 50, leaseMs: 100 });
assert.equal(renewed.leaseExpiresAt, 150);
assert.throws(
  () => renewAgentTaskLease(graph, "collect", { attemptId: "stale", workerId: "worker-1", now: 51, leaseMs: 100 }),
  /AGENT_TASK_ATTEMPT_MISMATCH/,
);
assert.throws(
  () => completeAgentTask(graph, "collect", { attemptId: "wrong", workerId: "worker-1", handoff: "x", now: 12 }),
  /AGENT_TASK_ATTEMPT_MISMATCH/,
);
completeAgentTask(graph, "collect", {
  attemptId: claim.attemptId,
  workerId: "worker-1",
  handoff: "Evidence A",
  now: 52,
});
assert.equal(graph.tasks.collect.status, "completed");
assert.equal(graph.tasks.summarize.status, "ready", "dependency completion releases the next node");

const summaryClaim = claimReadyTask(graph, { workerId: "worker-2", now: 20, leaseMs: 10 });
assert.equal(summaryClaim.taskId, "summarize");
assert.deepEqual(expireAgentTaskLeases(graph, { now: 31 }), ["summarize"]);
assert.equal(graph.tasks.summarize.status, "failed", "unsafe expired tasks never replay automatically");

const retryGraph = createAgentTaskGraph({ id: "graph-retry", taskRunId: "run-r", sessionId: "s-r", principalId: "p-r", now: 1 });
addAgentTask(retryGraph, { id: "read", objective: "Read", replaySafe: true, maxAttempts: 2 });
const first = claimReadyTask(retryGraph, { workerId: "w1", now: 2, leaseMs: 10 });
failAgentTask(retryGraph, "read", { attemptId: first.attemptId, workerId: "w1", error: "temporary", now: 3 });
assert.equal(retryGraph.tasks.read.status, "ready", "explicit replay-safe work gets a bounded retry");
const second = claimReadyTask(retryGraph, { workerId: "w2", now: 4, leaseMs: 10 });
failAgentTask(retryGraph, "read", { attemptId: second.attemptId, workerId: "w2", error: "again", now: 5 });
assert.equal(retryGraph.tasks.read.status, "failed", "retry budget is enforced");

const cancelGraph = createAgentTaskGraph({ id: "graph-cancel", taskRunId: "run-c", sessionId: "s-c", principalId: "p-c", now: 1 });
addAgentTask(cancelGraph, { id: "a", objective: "A" });
addAgentTask(cancelGraph, { id: "b", objective: "B", dependsOn: ["a"] });
cancelAgentTask(cancelGraph, "a", { reason: "user", now: 2 });
assert.equal(cancelGraph.tasks.a.status, "cancelled");
assert.equal(cancelGraph.tasks.b.status, "cancelled", "dependency cancellation propagates deterministically");

console.log("agent-task-graph: ok");
