"use strict";

/**
 * Run lifecycle: a run row is born queued, handed to the turn orchestrator,
 * marked running when the engine takes it, and closed with a terminal status.
 * Every function takes the ScheduledTaskManager; the manager keeps thin
 * delegates so call sites and tests are unchanged.
 */
const crypto = require("node:crypto");
const { dispatchScheduledRun, reconcileScheduledRunWithTurn } = require("./scheduled-task-dispatch");
const { computeNextRunAt, nowIso, safeText } = require("./schedule-parser");
const { executionLoad } = require("./scheduled-task-run-policy");
const { getLogger } = require("./logger");

const log = getLogger("scheduler");

function markRunStarted(manager, runId, turnId, dispatchAttemptId = null, dispatchStartedAt = null) {
  const run = manager.runs.find((item) => item.id === runId && item.status === "queued");
  if (!run) return false;
  run.status = "running";
  run.startedAt = nowIso();
  run.turnId = turnId || null;
  run.dispatchAttemptId = dispatchAttemptId || null;
  run.dispatchStartedAt = dispatchAttemptId && Number.isFinite(dispatchStartedAt)
    ? dispatchStartedAt
    : null;
  run.leaseExpiresAt = new Date(Date.now() + manager.leaseMs).toISOString();
  const task = manager.tasks.find((item) => item.id === run.taskId);
  if (task) {
    task.status = "running";
    manager.store?.saveTask(task);
  }
  manager.store?.saveRun(run);
  return true;
}

function dispatchRun(manager, task, run, opts = {}) {
  manager._dispatchingRunIds.add(run.id);
  dispatchScheduledRun({
    ctx: manager.ctx, task, run, nonInteractive: opts.nonInteractive,
    markRunStarted: (runId, turnId) => manager.markRunStarted(runId, turnId),
    reconcileRun: reconcileScheduledRunWithTurn,
    finishRun: (target, type, payload) => manager._finishRun(target, type, payload),
    saveRun: (target) => manager.store?.saveRun(target),
    onSettled: () => {
      manager._dispatchingRunIds.delete(run.id);
      queueMicrotask(() => void manager.tick());
    },
  });
}

function dispatchRecoveredQueuedRuns(manager) {
  for (const runId of manager._recoveredQueuedRunIds) {
    const run = manager.runs.find((item) => item.id === runId && item.status === "queued");
    const task = run && manager.tasks.find((item) => item.id === run.taskId);
    if (!run || !task) {
      manager._recoveredQueuedRunIds.delete(runId);
      continue;
    }
    if (run.ownerPrincipal !== manager._principal()) continue;
    if (executionLoad(manager.runs, manager._dispatchingRunIds, run.ownerPrincipal) >= manager.maxConcurrentRuns) break;
    manager._recoveredQueuedRunIds.delete(runId);
    manager._dispatchRun(task, run, { nonInteractive: true });
  }
}

function finishRun(manager, run, terminalType, payload = {}) {
  run.status = terminalType === "turn.completed" ? "succeeded" : terminalType.replace(/^turn\./, "");
  run.finishedAt = nowIso();
  run.leaseExpiresAt = null;
  run.error = run.status === "succeeded" ? null : payload?.error || payload?.errorCode || terminalType;
  manager.store?.saveRun(run);
  const task = manager.tasks.find((item) => item.id === run.taskId);
  if (run.status !== "succeeded") log.warn("run %s (task %s) ended %s: %s", run.id, run.taskId, run.status, run.error || "-");
  if (task) {
    task.status = task.enabled ? "scheduled" : (task.status === "completed" ? "completed" : "paused");
    task.lastRunAt = run.finishedAt;
    task.lastError = run.status === "succeeded" ? null : run.error;
    task.updatedAt = nowIso();
    manager.store?.saveTask(task);
    const oneShot = task.schedule?.type === "once";
    const exhausted = !task.nextRunAt && !computeNextRunAt(task.schedule);
    if (manager.selfHeal && task.enabled && !run.manual && (oneShot || exhausted)) {
      // Success closes the schedule; a failed one-shot stays visibly failed and
      // reachable through "run now" instead of being filed as completed.
      if (run.status === "succeeded") manager._retireTask(task, oneShot ? "once_completed" : "schedule_exhausted");
      else manager._pauseTask(task, run.error || run.status);
    }
    const assistant = safeText(payload?.assistant, 12000);
    if (assistant && task.originSessionId !== task.executionSessionId) {
      manager.ctx?.sessionManager?.pushMessageTo?.(task.originSessionId, "assistant", assistant, null, {
        meta: {
          scheduledTaskId: task.id,
          scheduledTaskRunId: run.id,
          executionSessionId: task.executionSessionId,
        },
      });
    }
  }
  queueMicrotask(() => void manager.tick());
}

function newRun(manager, task, scheduledFor, manual) {
  const queuedAt = nowIso();
  return {
    id: `run_${crypto.randomUUID()}`,
    taskId: task.id,
    ownerPrincipal: task.ownerPrincipal,
    sessionId: task.executionSessionId,
    originSessionId: task.originSessionId,
    projectId: task.projectId,
    scheduledFor,
    occurrenceKey: `${task.id}:${scheduledFor}`,
    status: "queued",
    leaseOwner: manager._leaseOwner,
    leaseExpiresAt: new Date(Date.now() + manager.leaseMs).toISOString(),
    queuedAt,
    startedAt: null,
    finishedAt: null,
    turnId: null,
    queueItemId: null,
    error: null,
    manual,
    dispatchAttemptId: null, dispatchStartedAt: null, engineAcceptedAt: null,
  };
}


module.exports = { dispatchRecoveredQueuedRuns, dispatchRun, finishRun, markRunStarted, newRun };
