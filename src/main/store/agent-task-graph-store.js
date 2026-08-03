"use strict";

const crypto = require("node:crypto");
const {
  addAgentTask,
  cancelAgentTask,
  claimAgentTask,
  claimReadyTask,
  completeAgentTask,
  expireAgentTaskLeases,
  failAgentTask,
  renewAgentTaskLease,
} = require("../agent-task-graph");

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function migrateAgentTaskGraphSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_task_graphs (
      id TEXT PRIMARY KEY,
      task_run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      max_concurrency INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_graph_session
      ON agent_task_graphs(session_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      graph_id TEXT NOT NULL,
      id TEXT NOT NULL,
      objective TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL,
      replay_safe INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      active_attempt_id TEXT NOT NULL DEFAULT '',
      worker_id TEXT NOT NULL DEFAULT '',
      lease_expires_at INTEGER,
      handoff TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (graph_id, id),
      FOREIGN KEY (graph_id) REFERENCES agent_task_graphs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_ready
      ON agent_tasks(graph_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease
      ON agent_tasks(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS agent_task_edges (
      graph_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (graph_id, task_id, depends_on_task_id),
      FOREIGN KEY (graph_id, task_id) REFERENCES agent_tasks(graph_id, id) ON DELETE CASCADE,
      FOREIGN KEY (graph_id, depends_on_task_id) REFERENCES agent_tasks(graph_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_task_attempts (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (graph_id, task_id) REFERENCES agent_tasks(graph_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_attempt_task
      ON agent_task_attempts(graph_id, task_id, started_at);

    CREATE TABLE IF NOT EXISTS agent_mailbox_messages (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      FOREIGN KEY (graph_id) REFERENCES agent_task_graphs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mailbox_recipient
      ON agent_mailbox_messages(graph_id, session_id, to_agent_id, acknowledged_at, created_at);
  `);
}

function taskFromRow(row) {
  return {
    id: row.id,
    objective: row.objective,
    agentId: row.agent_id,
    depth: Number(row.depth),
    dependsOn: [],
    status: row.status,
    replaySafe: Boolean(row.replay_safe),
    maxAttempts: Number(row.max_attempts),
    attemptCount: Number(row.attempt_count),
    activeAttemptId: row.active_attempt_id || "",
    workerId: row.worker_id || "",
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    handoff: row.handoff || "",
    error: row.error || "",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    attempts: [],
  };
}

class AgentTaskGraphStore {
  constructor(db, { now = () => Date.now() } = {}) {
    if (!db) throw codedError("AGENT_GRAPH_DB_REQUIRED");
    this.db = db;
    this.now = now;
  }

  create(graph) {
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO agent_task_graphs
          (id, task_run_id, session_id, principal_id, status, revision,
           max_concurrency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        graph.id, graph.taskRunId, graph.sessionId, graph.principalId, graph.status,
        graph.revision, graph.maxConcurrency, graph.createdAt, graph.updatedAt,
      );
      this._replaceChildren(graph);
      return graph;
    })();
  }

  _scopeRow(graphId, sessionId) {
    const row = this.db.get("SELECT * FROM agent_task_graphs WHERE id=?", graphId);
    if (!row) throw codedError("AGENT_GRAPH_NOT_FOUND", graphId);
    if (row.session_id !== sessionId) throw codedError("AGENT_GRAPH_SCOPE_MISMATCH");
    return row;
  }

  get(graphId, sessionId) {
    const row = this._scopeRow(graphId, sessionId);
    const tasks = {};
    for (const taskRow of this.db.all("SELECT * FROM agent_tasks WHERE graph_id=? ORDER BY created_at, id", graphId)) {
      tasks[taskRow.id] = taskFromRow(taskRow);
    }
    for (const edge of this.db.all("SELECT task_id, depends_on_task_id FROM agent_task_edges WHERE graph_id=?", graphId)) {
      if (tasks[edge.task_id]) tasks[edge.task_id].dependsOn.push(edge.depends_on_task_id);
    }
    for (const attempt of this.db.all("SELECT * FROM agent_task_attempts WHERE graph_id=? ORDER BY started_at, id", graphId)) {
      if (!tasks[attempt.task_id]) continue;
      tasks[attempt.task_id].attempts.push({
        id: attempt.id,
        workerId: attempt.worker_id,
        status: attempt.status,
        startedAt: Number(attempt.started_at),
        endedAt: attempt.ended_at == null ? null : Number(attempt.ended_at),
        error: attempt.error || "",
      });
    }
    return {
      schemaVersion: 1,
      id: row.id,
      taskRunId: row.task_run_id,
      sessionId: row.session_id,
      principalId: row.principal_id,
      status: row.status,
      revision: Number(row.revision),
      maxConcurrency: Number(row.max_concurrency),
      tasks,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  _replaceChildren(graph) {
    this.db.run("DELETE FROM agent_task_attempts WHERE graph_id=?", graph.id);
    this.db.run("DELETE FROM agent_task_edges WHERE graph_id=?", graph.id);
    this.db.run("DELETE FROM agent_tasks WHERE graph_id=?", graph.id);
    for (const task of Object.values(graph.tasks)) {
      this.db.run(
        `INSERT INTO agent_tasks
          (graph_id, id, objective, agent_id, depth, status, replay_safe,
           max_attempts, attempt_count, active_attempt_id, worker_id,
           lease_expires_at, handoff, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        graph.id, task.id, task.objective, task.agentId, task.depth, task.status,
        task.replaySafe ? 1 : 0, task.maxAttempts, task.attemptCount,
        task.activeAttemptId || "", task.workerId || "", task.leaseExpiresAt,
        task.handoff || "", task.error || "", task.createdAt, task.updatedAt,
      );
    }
    for (const task of Object.values(graph.tasks)) {
      for (const dependency of task.dependsOn) {
        this.db.run(
          "INSERT INTO agent_task_edges (graph_id, task_id, depends_on_task_id) VALUES (?, ?, ?)",
          graph.id, task.id, dependency,
        );
      }
      for (const attempt of task.attempts) {
        this.db.run(
          `INSERT INTO agent_task_attempts
            (id, graph_id, task_id, worker_id, status, started_at, ended_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          attempt.id, graph.id, task.id, attempt.workerId, attempt.status,
          attempt.startedAt, attempt.endedAt, attempt.error || "",
        );
      }
    }
  }

  _save(graph, expectedRevision) {
    const result = this.db.run(
      `UPDATE agent_task_graphs SET status=?, revision=?, max_concurrency=?, updated_at=?
       WHERE id=? AND session_id=? AND revision=?`,
      graph.status, graph.revision, graph.maxConcurrency, graph.updatedAt,
      graph.id, graph.sessionId, expectedRevision,
    );
    if (Number(result.changes || 0) !== 1) throw codedError("AGENT_GRAPH_REVISION_CONFLICT");
    this._replaceChildren(graph);
  }

  claimReady(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const claim = claimReadyTask(graph, input);
      if (!claim) return null;
      this._save(graph, revision);
      return claim;
    })();
  }

  addTask(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const task = addAgentTask(graph, input.task || input);
      this._save(graph, revision);
      return task;
    })();
  }

  claimTask(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const claim = claimAgentTask(graph, input.taskId, input);
      if (!claim) return null;
      this._save(graph, revision);
      return claim;
    })();
  }

  complete(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const task = completeAgentTask(graph, input.taskId, input);
      this._save(graph, revision);
      return task;
    })();
  }

  fail(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const task = failAgentTask(graph, input.taskId, input);
      this._save(graph, revision);
      return task;
    })();
  }

  renew(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const lease = renewAgentTaskLease(graph, input.taskId, input);
      this._save(graph, revision);
      return lease;
    })();
  }

  cancel(input = {}) {
    return this.db.transaction(() => {
      const graph = this.get(input.graphId, input.sessionId);
      const revision = graph.revision;
      const changed = cancelAgentTask(graph, input.taskId, input);
      if (changed) this._save(graph, revision);
      return changed;
    })();
  }

  restoreSnapshot(graphId, sessionId, snapshot, { now = this.now() } = {}) {
    return this.db.transaction(() => {
      const current = this.get(graphId, sessionId);
      if (!snapshot || snapshot.id !== graphId || snapshot.sessionId !== sessionId) {
        throw codedError("AGENT_GRAPH_SCOPE_MISMATCH");
      }
      const restored = JSON.parse(JSON.stringify(snapshot));
      restored.revision = current.revision;
      restored.updatedAt = Number(now);
      for (const task of Object.values(restored.tasks || {})) {
        if (task.status === "running") cancelAgentTask(restored, task.id, { reason: "checkpoint_restore_cancelled_lease", now });
      }
      restored.revision = current.revision + 1;
      this._save(restored, current.revision);
      return this.get(graphId, sessionId);
    })();
  }

  expireLeases({ now = this.now() } = {}) {
    const rows = this.db.all(
      `SELECT DISTINCT g.id, g.session_id
       FROM agent_task_graphs g JOIN agent_tasks t ON t.graph_id=g.id
       WHERE t.status='running' AND t.lease_expires_at <= ?`,
      now,
    );
    let count = 0;
    for (const row of rows) {
      count += this.db.transaction(() => {
        const graph = this.get(row.id, row.session_id);
        const revision = graph.revision;
        const expired = expireAgentTaskLeases(graph, { now });
        if (expired.length) this._save(graph, revision);
        return expired.length;
      })();
    }
    return count;
  }

  sendMessage(input = {}) {
    this._scopeRow(input.graphId, input.sessionId);
    const body = String(input.body || "").trim();
    if (!body || body.length > 16_000) throw codedError("AGENT_MAILBOX_BODY_INVALID");
    const item = {
      id: input.id || `mail_${crypto.randomUUID()}`,
      graphId: input.graphId,
      sessionId: input.sessionId,
      fromAgentId: String(input.fromAgentId || "").trim(),
      toAgentId: String(input.toAgentId || "").trim(),
      body,
      createdAt: Number(input.now ?? this.now()),
      acknowledgedAt: null,
    };
    if (!item.fromAgentId || !item.toAgentId) throw codedError("AGENT_MAILBOX_AGENT_INVALID");
    this.db.run(
      `INSERT INTO agent_mailbox_messages
        (id, graph_id, session_id, from_agent_id, to_agent_id, body, created_at, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      item.id, item.graphId, item.sessionId, item.fromAgentId, item.toAgentId, item.body, item.createdAt,
    );
    return item;
  }

  listMessages(input = {}) {
    this._scopeRow(input.graphId, input.sessionId);
    const whereAgent = input.agentId ? " AND to_agent_id=?" : "";
    const params = input.agentId
      ? [input.graphId, input.sessionId, input.agentId]
      : [input.graphId, input.sessionId];
    return this.db.all(
      `SELECT * FROM agent_mailbox_messages
       WHERE graph_id=? AND session_id=?${whereAgent}
       ORDER BY created_at, id`,
      ...params,
    ).map((row) => ({
      id: row.id,
      graphId: row.graph_id,
      sessionId: row.session_id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      body: row.body,
      createdAt: Number(row.created_at),
      acknowledgedAt: row.acknowledged_at == null ? null : Number(row.acknowledged_at),
    }));
  }

  acknowledgeMessage(input = {}) {
    this._scopeRow(input.graphId, input.sessionId);
    const result = this.db.run(
      `UPDATE agent_mailbox_messages SET acknowledged_at=?
       WHERE id=? AND graph_id=? AND session_id=? AND to_agent_id=? AND acknowledged_at IS NULL`,
      Number(input.now ?? this.now()), input.messageId, input.graphId, input.sessionId, input.agentId,
    );
    return Number(result.changes || 0) === 1;
  }
}

module.exports = { AgentTaskGraphStore, migrateAgentTaskGraphSchema };
