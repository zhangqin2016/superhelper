"use strict";

const { isSubagentTool, subagentTitle } = require("./subagent-telemetry");
const { getLogger } = require("./logger");

const log = getLogger("agent-task-projection");

function projectedTaskId(tool = {}) {
  const id = String(tool.id || "").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 180);
  return id ? `worker_${id}` : "";
}

function subagentHandoffText(value) {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = String(raw || "").trim();
  const result = text.match(/<task_result>([\s\S]*?)<\/task_result>/i);
  return (result ? result[1] : text).trim().slice(0, 16_000);
}

function syncAgentTaskFromTool({ store, state, sessionId, tool, now = Date.now(), emit = () => {} } = {}) {
  if (!store || !state?.taskRun?.agentGraphId || !isSubagentTool(tool)) return null;
  const graphId = state.taskRun.agentGraphId;
  const taskId = projectedTaskId(tool);
  if (!taskId) return null;
  const metadata = tool.metadata || {};
  const workerId = String(metadata.sessionId || metadata.sessionID || `worker:${tool.id}`).slice(0, 256);
  try {
    let graph = store.get(graphId, sessionId);
    let task = graph.tasks[taskId];
    if (!task) {
      task = store.addTask({
        graphId,
        sessionId,
        task: {
          id: taskId,
          objective: subagentTitle(tool) || "Execute delegated task",
          agentId: workerId,
          depth: 1,
          replaySafe: false,
          maxAttempts: 1,
          now,
        },
      });
      emit("agent.spawned", { graphId, taskId, agentId: workerId, objective: task.objective });
      graph = store.get(graphId, sessionId);
      task = graph.tasks[taskId];
    }
    if (task.status === "ready") {
      const claim = store.claimTask({ graphId, sessionId, taskId, workerId, now, leaseMs: 24 * 60 * 60 * 1_000 });
      if (claim) emit("agent.started", { graphId, taskId, agentId: workerId, attemptId: claim.attemptId });
      task = store.get(graphId, sessionId).tasks[taskId];
    }
    if (task.status === "running" && !["done", "completed", "failed"].includes(String(tool.status || ""))) {
      store.renew({
        graphId,
        sessionId,
        taskId,
        workerId: task.workerId,
        attemptId: task.activeAttemptId,
        now,
        leaseMs: 24 * 60 * 60 * 1_000,
      });
      return store.get(graphId, sessionId).tasks[taskId];
    }
    if (task.status !== "running" || !["done", "completed", "failed"].includes(String(tool.status || ""))) return task;
    const input = {
      graphId,
      sessionId,
      taskId,
      workerId: task.workerId,
      attemptId: task.activeAttemptId,
      now,
    };
    if (tool.status === "failed") {
      const failed = store.fail({ ...input, error: String(tool.result || tool.error || "delegated task failed") });
      emit("agent.completed", { graphId, taskId, agentId: workerId, status: "failed", error: failed.error });
      return failed;
    }
    const handoff = subagentHandoffText(tool.result);
    if (!handoff) {
      const failed = store.fail({ ...input, error: "SUBAGENT_HANDOFF_EMPTY" });
      emit("agent.completed", { graphId, taskId, agentId: workerId, status: "failed", error: failed.error });
      return failed;
    }
    const completed = store.complete({ ...input, handoff });
    emit("agent.completed", { graphId, taskId, agentId: workerId, status: "completed", handoff: completed.handoff });
    return completed;
  } catch (err) {
    log.warn("subagent task projection failed open: %s", err?.message || err);
    return null;
  }
}

module.exports = { projectedTaskId, subagentHandoffText, syncAgentTaskFromTool };
