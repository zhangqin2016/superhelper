"use strict";

const crypto = require("node:crypto");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_TASKS = 256;
const MAX_OBJECTIVE_CHARS = 2_000;
const MAX_HANDOFF_CHARS = 16_000;

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function bounded(value, name, max = 256) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw codedError("AGENT_TASK_FIELD_INVALID", name);
  }
  return text;
}

function timestamp(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) throw codedError("AGENT_TASK_TIME_INVALID");
  return number;
}

function touch(graph, now) {
  graph.revision += 1;
  graph.updatedAt = timestamp(now);
  return graph;
}

function createAgentTaskGraph(input = {}) {
  const now = timestamp(input.now ?? Date.now());
  const maxConcurrency = Math.floor(Number(input.maxConcurrency ?? 4));
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
    throw codedError("AGENT_GRAPH_CONCURRENCY_INVALID");
  }
  return {
    schemaVersion: 1,
    id: bounded(input.id || `graph_${crypto.randomUUID()}`, "id"),
    taskRunId: bounded(input.taskRunId, "taskRunId"),
    sessionId: bounded(input.sessionId, "sessionId"),
    principalId: bounded(input.principalId, "principalId"),
    status: "running",
    revision: 0,
    maxConcurrency,
    tasks: {},
    createdAt: now,
    updatedAt: now,
  };
}

function dependenciesComplete(graph, task) {
  return task.dependsOn.every((id) => graph.tasks[id]?.status === "completed");
}

function addAgentTask(graph, input = {}) {
  if (!graph || graph.status !== "running") throw codedError("AGENT_GRAPH_NOT_RUNNING");
  if (Object.keys(graph.tasks).length >= MAX_TASKS) throw codedError("AGENT_GRAPH_TASK_LIMIT");
  const id = bounded(input.id || `agent_task_${crypto.randomUUID()}`, "task.id");
  if (graph.tasks[id]) throw codedError("AGENT_TASK_DUPLICATE", id);
  const depth = Math.floor(Number(input.depth ?? 1));
  if (depth < 0 || depth > 1) throw codedError("AGENT_TASK_DEPTH_EXCEEDED");
  const dependsOn = [...new Set((Array.isArray(input.dependsOn) ? input.dependsOn : []).map((value) => bounded(value, "dependsOn")))];
  if (dependsOn.includes(id)) throw codedError("AGENT_TASK_SELF_DEPENDENCY");
  for (const dependency of dependsOn) {
    if (!graph.tasks[dependency]) throw codedError("AGENT_TASK_DEPENDENCY_NOT_FOUND", dependency);
  }
  const maxAttempts = Math.floor(Number(input.maxAttempts ?? 1));
  if (maxAttempts < 1 || maxAttempts > 10) throw codedError("AGENT_TASK_ATTEMPT_LIMIT_INVALID");
  const task = {
    id,
    objective: bounded(input.objective, "objective", MAX_OBJECTIVE_CHARS),
    agentId: bounded(input.agentId || id, "agentId"),
    depth,
    dependsOn,
    status: dependsOn.length ? "blocked" : "ready",
    replaySafe: input.replaySafe === true,
    maxAttempts,
    attemptCount: 0,
    activeAttemptId: "",
    workerId: "",
    leaseExpiresAt: null,
    handoff: "",
    error: "",
    createdAt: graph.updatedAt,
    updatedAt: graph.updatedAt,
    attempts: [],
  };
  graph.tasks[id] = task;
  touch(graph, input.now ?? graph.updatedAt);
  return task;
}

function runningCount(graph) {
  return Object.values(graph.tasks).filter((task) => task.status === "running").length;
}

function claimTask(graph, task, input, now) {
  if (!task || task.status !== "ready") return null;
  const workerId = bounded(input.workerId, "workerId");
  const leaseMs = Math.floor(Number(input.leaseMs ?? 60_000));
  if (leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1_000) throw codedError("AGENT_TASK_LEASE_INVALID");
  const attemptId = `attempt_${crypto.randomUUID()}`;
  task.status = "running";
  task.attemptCount += 1;
  task.activeAttemptId = attemptId;
  task.workerId = workerId;
  task.leaseExpiresAt = now + leaseMs;
  task.updatedAt = now;
  task.attempts.push({ id: attemptId, workerId, status: "running", startedAt: now, endedAt: null, error: "" });
  touch(graph, now);
  return { graphId: graph.id, sessionId: graph.sessionId, taskId: task.id, attemptId, workerId, leaseExpiresAt: task.leaseExpiresAt };
}

function claimAgentTask(graph, taskId, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  if (graph.status !== "running" || runningCount(graph) >= graph.maxConcurrency) return null;
  return claimTask(graph, graph.tasks[bounded(taskId, "taskId")], input, now);
}

function claimReadyTask(graph, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  if (graph.status !== "running" || runningCount(graph) >= graph.maxConcurrency) return null;
  const task = Object.values(graph.tasks)
    .filter((candidate) => candidate.status === "ready")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  if (!task) return null;
  return claimTask(graph, task, input, now);
}

function requireActiveAttempt(task, input = {}) {
  if (!task || task.status !== "running") throw codedError("AGENT_TASK_NOT_RUNNING");
  if (task.activeAttemptId !== String(input.attemptId || "") || task.workerId !== String(input.workerId || "")) {
    throw codedError("AGENT_TASK_ATTEMPT_MISMATCH");
  }
  const attempt = task.attempts.find((candidate) => candidate.id === task.activeAttemptId);
  if (!attempt || attempt.status !== "running") throw codedError("AGENT_TASK_ATTEMPT_MISMATCH");
  return attempt;
}

function renewAgentTaskLease(graph, taskId, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  const task = graph.tasks[bounded(taskId, "taskId")];
  requireActiveAttempt(task, input);
  const leaseMs = Math.floor(Number(input.leaseMs ?? 60_000));
  if (leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1_000) throw codedError("AGENT_TASK_LEASE_INVALID");
  if (Number(task.leaseExpiresAt || 0) <= now) throw codedError("AGENT_TASK_LEASE_EXPIRED");
  task.leaseExpiresAt = Math.max(task.leaseExpiresAt, now + leaseMs);
  task.updatedAt = now;
  touch(graph, now);
  return { taskId: task.id, attemptId: task.activeAttemptId, workerId: task.workerId, leaseExpiresAt: task.leaseExpiresAt };
}

function releaseDependents(graph, now) {
  let released = 0;
  for (const task of Object.values(graph.tasks)) {
    if (task.status === "blocked" && dependenciesComplete(graph, task)) {
      task.status = "ready";
      task.updatedAt = now;
      released += 1;
    }
  }
  return released;
}

function updateGraphTerminalStatus(graph) {
  const tasks = Object.values(graph.tasks);
  if (!tasks.length || tasks.some((task) => !TERMINAL.has(task.status))) return;
  graph.status = tasks.every((task) => task.status === "completed") ? "completed" : "failed";
}

function completeAgentTask(graph, taskId, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  const task = graph.tasks[bounded(taskId, "taskId")];
  const attempt = requireActiveAttempt(task, input);
  const handoff = String(input.handoff || "").trim();
  if (handoff.length > MAX_HANDOFF_CHARS) throw codedError("AGENT_TASK_HANDOFF_TOO_LARGE");
  attempt.status = "completed";
  attempt.endedAt = now;
  task.status = "completed";
  task.handoff = handoff;
  task.activeAttemptId = "";
  task.workerId = "";
  task.leaseExpiresAt = null;
  task.updatedAt = now;
  releaseDependents(graph, now);
  updateGraphTerminalStatus(graph);
  touch(graph, now);
  return task;
}

function failAgentTask(graph, taskId, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  const task = graph.tasks[bounded(taskId, "taskId")];
  const attempt = requireActiveAttempt(task, input);
  const error = String(input.error || "worker failed").slice(0, 2_000);
  attempt.status = "failed";
  attempt.error = error;
  attempt.endedAt = now;
  task.error = error;
  task.activeAttemptId = "";
  task.workerId = "";
  task.leaseExpiresAt = null;
  task.status = task.replaySafe && task.attemptCount < task.maxAttempts ? "ready" : "failed";
  task.updatedAt = now;
  if (task.status === "failed") cancelDependents(graph, task.id, "dependency_failed", now);
  updateGraphTerminalStatus(graph);
  touch(graph, now);
  return task;
}

function cancelDependents(graph, taskId, reason, now) {
  for (const task of Object.values(graph.tasks)) {
    if (!TERMINAL.has(task.status) && task.dependsOn.includes(taskId)) {
      task.status = "cancelled";
      task.error = reason;
      task.activeAttemptId = "";
      task.workerId = "";
      task.leaseExpiresAt = null;
      task.updatedAt = now;
      cancelDependents(graph, task.id, reason, now);
    }
  }
}

function cancelAgentTask(graph, taskId, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  const task = graph.tasks[bounded(taskId, "taskId")];
  if (!task) throw codedError("AGENT_TASK_NOT_FOUND");
  if (TERMINAL.has(task.status)) return false;
  const attempt = task.attempts.find((candidate) => candidate.id === task.activeAttemptId);
  if (attempt) {
    attempt.status = "cancelled";
    attempt.endedAt = now;
  }
  task.status = "cancelled";
  task.error = String(input.reason || "cancelled").slice(0, 2_000);
  task.activeAttemptId = "";
  task.workerId = "";
  task.leaseExpiresAt = null;
  task.updatedAt = now;
  cancelDependents(graph, task.id, "dependency_cancelled", now);
  updateGraphTerminalStatus(graph);
  touch(graph, now);
  return true;
}

function expireAgentTaskLeases(graph, input = {}) {
  const now = timestamp(input.now ?? Date.now());
  const expired = [];
  for (const task of Object.values(graph.tasks)) {
    if (task.status !== "running" || Number(task.leaseExpiresAt || 0) > now) continue;
    const attempt = task.attempts.find((candidate) => candidate.id === task.activeAttemptId);
    if (attempt) {
      attempt.status = "orphaned";
      attempt.error = "lease_expired";
      attempt.endedAt = now;
    }
    task.status = task.replaySafe && task.attemptCount < task.maxAttempts ? "ready" : "failed";
    task.error = "lease_expired";
    task.activeAttemptId = "";
    task.workerId = "";
    task.leaseExpiresAt = null;
    task.updatedAt = now;
    if (task.status === "failed") cancelDependents(graph, task.id, "dependency_failed", now);
    expired.push(task.id);
  }
  if (expired.length) {
    updateGraphTerminalStatus(graph);
    touch(graph, now);
  }
  return expired;
}

module.exports = {
  addAgentTask,
  cancelAgentTask,
  claimAgentTask,
  claimReadyTask,
  completeAgentTask,
  createAgentTaskGraph,
  expireAgentTaskLeases,
  failAgentTask,
  renewAgentTaskLease,
};
