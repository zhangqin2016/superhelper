#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { createAgentTaskGraph, addAgentTask } = require("../src/main/agent-task-graph.js");
const {
  AgentTaskGraphStore,
  migrateAgentTaskGraphSchema,
} = require("../src/main/store/agent-task-graph-store.js");
const { createTaskRunRuntime } = require("../src/main/task-run-runtime.js");
const { syncAgentTaskFromTool } = require("../src/main/agent-task-projection.js");

const db = openDatabase(":memory:");
try {
  migrateAgentTaskGraphSchema(db);
  const store = new AgentTaskGraphStore(db, { now: () => 100 });
  const firstGraph = createAgentTaskGraph({ id: "g1", taskRunId: "r1", sessionId: "s1", principalId: "p1", now: 1 });
  addAgentTask(firstGraph, { id: "a", objective: "A", replaySafe: true, maxAttempts: 2 });
  addAgentTask(firstGraph, { id: "b", objective: "B", dependsOn: ["a"] });
  store.create(firstGraph);

  const secondGraph = createAgentTaskGraph({ id: "g2", taskRunId: "r2", sessionId: "s2", principalId: "p2", now: 1 });
  addAgentTask(secondGraph, { id: "x", objective: "X" });
  store.create(secondGraph);

  const claim1 = store.claimReady({ graphId: "g1", sessionId: "s1", workerId: "w1", now: 10, leaseMs: 100 });
  assert.equal(claim1.taskId, "a");
  const renewed = store.renew({ graphId: "g1", sessionId: "s1", taskId: "a", workerId: "w1", attemptId: claim1.attemptId, now: 50, leaseMs: 100 });
  assert.equal(renewed.leaseExpiresAt, 150);
  assert.throws(
    () => store.renew({ graphId: "g1", sessionId: "s2", taskId: "a", workerId: "w1", attemptId: claim1.attemptId, now: 51, leaseMs: 100 }),
    /AGENT_GRAPH_SCOPE_MISMATCH/,
  );
  assert.equal(store.claimReady({ graphId: "g1", sessionId: "s1", workerId: "w2", now: 11, leaseMs: 100 }), null);
  assert.throws(
    () => store.claimReady({ graphId: "g1", sessionId: "s2", workerId: "w2", now: 11, leaseMs: 100 }),
    /AGENT_GRAPH_SCOPE_MISMATCH/,
  );
  const claim2 = store.claimReady({ graphId: "g2", sessionId: "s2", workerId: "w2", now: 11, leaseMs: 100 });
  assert.equal(claim2.taskId, "x", "another session claims its own work independently");

  store.complete({
    graphId: "g1",
    sessionId: "s1",
    taskId: "a",
    workerId: "w1",
    attemptId: claim1.attemptId,
    handoff: "done A",
    now: 60,
  });
  assert.equal(store.get("g1", "s1").tasks.b.status, "ready");

  const b = store.claimReady({ graphId: "g1", sessionId: "s1", workerId: "w1", now: 70, leaseMs: 10 });
  assert.equal(b.taskId, "b");
  assert.equal(store.expireLeases({ now: 81 }), 1);
  assert.equal(store.get("g1", "s1").tasks.b.status, "failed");

  const m1 = store.sendMessage({ graphId: "g1", sessionId: "s1", fromAgentId: "lead", toAgentId: "w1", body: "check file", now: 50 });
  const m2 = store.sendMessage({ graphId: "g1", sessionId: "s1", fromAgentId: "w1", toAgentId: "lead", body: "done", now: 51 });
  assert.deepEqual(store.listMessages({ graphId: "g1", sessionId: "s1" }).map((m) => m.id), [m1.id, m2.id]);
  assert.deepEqual(store.listMessages({ graphId: "g2", sessionId: "s2" }), [], "mailboxes never cross sessions");
  assert.equal(store.acknowledgeMessage({ graphId: "g1", sessionId: "s1", messageId: m1.id, agentId: "w1", now: 52 }), true);
  assert.equal(store.acknowledgeMessage({ graphId: "g1", sessionId: "s1", messageId: m2.id, agentId: "w1", now: 53 }), false, "only the recipient can acknowledge");

  const state = { turnId: "turn-runtime", startedAt: 60, taskRun: null, admittedTurnInput: { ownerScope: "owner-runtime" } };
  const emitted = [];
  const runtime = createTaskRunRuntime({
    getState: () => state,
    emitEvent: (_sessionId, event) => { emitted.push(event); return [event]; },
    agentTaskGraphStore: store,
    now: () => 60,
  });
  const taskRun = runtime.begin("session-runtime", "Do runtime work");
  assert.ok(taskRun.agentGraphId, "TaskRun lazily owns a durable agent graph");
  const projected = store.get(taskRun.agentGraphId, "session-runtime");
  assert.equal(Object.keys(projected.tasks).length, 1);
  assert.equal(Object.values(projected.tasks)[0].agentId, "lead");
  assert.equal(Object.values(projected.tasks)[0].status, "running", "lead attempt is durably claimed");
  assert.ok(emitted.some((event) => event.type === "agent.graph.created"));
  const workerTool = {
    id: "task-tool-1",
    name: "task",
    input: { description: "Inspect module" },
    metadata: { sessionId: "child-session-1" },
    status: "running",
  };
  syncAgentTaskFromTool({ store, state, sessionId: "session-runtime", tool: workerTool, now: 61 });
  assert.equal(store.get(taskRun.agentGraphId, "session-runtime").tasks["worker_task-tool-1"].status, "running");
  syncAgentTaskFromTool({ store, state, sessionId: "session-runtime", tool: { ...workerTool, status: "done", result: "inspected" }, now: 62 });
  assert.equal(store.get(taskRun.agentGraphId, "session-runtime").tasks["worker_task-tool-1"].handoff, "inspected");
  const emptyWorkerTool = {
    id: "task-tool-2",
    name: "task",
    input: { description: "Empty child" },
    metadata: { sessionId: "child-session-2" },
    status: "running",
  };
  syncAgentTaskFromTool({ store, state, sessionId: "session-runtime", tool: emptyWorkerTool, now: 63 });
  syncAgentTaskFromTool({
    store,
    state,
    sessionId: "session-runtime",
    tool: { ...emptyWorkerTool, status: "done", result: '<task_result>\n\n</task_result>' },
    now: 64,
  });
  assert.equal(
    store.get(taskRun.agentGraphId, "session-runtime").tasks["worker_task-tool-2"].status,
    "failed",
    "empty child handoff must not project as completed",
  );
  runtime.complete("session-runtime", "turn.completed");
  assert.equal(
    store.get(taskRun.agentGraphId, "session-runtime").status,
    "failed",
    "a failed child handoff must keep the parent graph from claiming complete coverage",
  );
  const restoredGraph = store.restoreSnapshot(taskRun.agentGraphId, "session-runtime", projected, { now: 70 });
  assert.equal(Object.values(restoredGraph.tasks)[0].status, "cancelled", "restored live leases are cancelled instead of replayed");
} finally {
  db.close();
}

console.log("agent-task-graph-store: ok");
