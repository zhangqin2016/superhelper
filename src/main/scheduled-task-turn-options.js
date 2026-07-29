"use strict";

function scheduledTaskTurnOptions(opts = {}) {
  return {
    scheduledTaskId: opts.scheduledTaskId || null,
    scheduledTaskRunId: opts.scheduledTaskRunId || null,
    scheduledTaskTitle: opts.scheduledTaskTitle || null,
    nonInteractive: opts.nonInteractive === true,
    permissionMode: opts.permissionMode || undefined,
  };
}

function scheduledQueueCapacityBlock(ctx, item) {
  const runId = item.options?.scheduledTaskRunId;
  if (!runId || ctx.scheduledTaskManager?.canStartRun?.(runId) !== false) return null;
  return { ok: false, retry: true, error: "SCHEDULE_CAPACITY" };
}

function cancelQueuedScheduledRun(orchestrator, sessionId, runId) {
  const state = orchestrator._state(sessionId);
  const index = state.queue.findIndex((item) => item.options?.scheduledTaskRunId === runId);
  if (index < 0) return { ok: false, error: "NOT_FOUND" };
  const [item] = state.queue.splice(index, 1);
  orchestrator._completeQueuedScheduledRun(item, "turn.interrupted", {
    errorCode: "ACCOUNT_CHANGED",
  });
  orchestrator._emitQueue(sessionId);
  return { ok: true, sessionId, queueLength: state.queue.length };
}

module.exports = { cancelQueuedScheduledRun, scheduledQueueCapacityBlock, scheduledTaskTurnOptions };
