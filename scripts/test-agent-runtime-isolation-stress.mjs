#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { issueRuntimeIdentity, verifyRuntimeIdentity } = require("../src/main/runtime-identity.js");
const { createAgentTaskGraph, addAgentTask } = require("../src/main/agent-task-graph.js");
const { AgentTaskGraphStore, migrateAgentTaskGraphSchema } = require("../src/main/store/agent-task-graph-store.js");
const { RuntimeCheckpointStore, migrateRuntimeCheckpointSchema } = require("../src/main/store/runtime-checkpoint-store.js");

const secret = "stress-secret-".repeat(4);
const db = openDatabase(":memory:");
try {
  migrateAgentTaskGraphSchema(db);
  migrateRuntimeCheckpointSchema(db);
  const graphs = new AgentTaskGraphStore(db);
  const checkpoints = new RuntimeCheckpointStore(db);
  const tokens = new Map();

  for (let i = 0; i < 10; i += 1) {
    const principalId = i < 5 ? "principal-a" : "principal-b";
    const sessionId = `session-${i}`;
    const token = issueRuntimeIdentity({
      principalId,
      workspaceId: `workspace-${i}`,
      projectId: `project-${i}`,
      sessionId,
      turnId: `turn-${i}`,
      taskRunId: `run-${i}`,
      agentId: "lead",
      attemptId: `attempt-${i}`,
      activeSkillIds: [`skill-${i}`],
    }, { secret, audience: "tool-broker", now: 1_000, ttlMs: 10_000, nonce: `nonce-${i}` });
    tokens.set(sessionId, token);

    const graph = createAgentTaskGraph({ id: `graph-${i}`, taskRunId: `run-${i}`, sessionId, principalId, now: 1 });
    addAgentTask(graph, { id: `task-${i}`, objective: `Task ${i}`, replaySafe: true, maxAttempts: 2 });
    graphs.create(graph);
    graphs.sendMessage({ graphId: graph.id, sessionId, fromAgentId: "lead", toAgentId: `worker-${i}`, body: `message-${i}`, now: i });

    const prepared = checkpoints.prepare({
      id: `checkpoint-${i}`,
      sessionId,
      turnId: `turn-${i}`,
      taskRunId: `run-${i}`,
      kind: "turn",
      components: [{ type: "agent_graph", refId: graph.id, version: 1, hash: String(i).padStart(64, "0"), reversible: true }],
      createdAt: i + 1,
    });
    checkpoints.commit(prepared.id, sessionId, prepared.integrityHash);
  }

  await Promise.all([...tokens.entries()].map(async ([sessionId, token], index) => {
    const identity = verifyRuntimeIdentity(token, { secret, audience: "tool-broker", now: 2_000, expected: { sessionId } });
    assert.equal(identity.activeSkillIds[0], `skill-${index}`);
    const claim = graphs.claimReady({ graphId: `graph-${index}`, sessionId, workerId: `worker-${index}`, now: 10, leaseMs: 100 });
    assert.equal(claim.taskId, `task-${index}`);
    assert.equal(graphs.listMessages({ graphId: `graph-${index}`, sessionId }).length, 1);
    assert.equal(checkpoints.get(`checkpoint-${index}`, sessionId).sessionId, sessionId);
  }));

  for (let i = 0; i < 10; i += 1) {
    const wrong = `session-${(i + 1) % 10}`;
    assert.throws(() => graphs.get(`graph-${i}`, wrong), /AGENT_GRAPH_SCOPE_MISMATCH/);
    assert.throws(() => checkpoints.get(`checkpoint-${i}`, wrong), /RUNTIME_CHECKPOINT_SCOPE_MISMATCH/);
    assert.throws(
      () => verifyRuntimeIdentity(tokens.get(`session-${i}`), { secret, audience: "tool-broker", now: 2_000, expected: { sessionId: wrong } }),
      /RUNTIME_IDENTITY_SCOPE_MISMATCH/,
    );
  }
} finally {
  db.close();
}

console.log("agent-runtime-isolation-stress: ok");
