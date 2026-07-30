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
  if (!state.queue.some((item) => item.options?.scheduledTaskRunId === runId)) {
    return { ok: false, error: "NOT_FOUND" };
  }
  const result = orchestrator._removeQueuedItemsDurably(
    sessionId,
    (item) => item.options?.scheduledTaskRunId === runId,
    "ACCOUNT_CHANGED",
  );
  if (result.rejected.length) {
    return {
      ok: false,
      error: result.rejected[0].result?.outcomeUnknown
        ? "DISPATCH_OUTCOME_UNKNOWN"
        : "QUEUE_CANCEL_FAILED",
      queueLength: result.queueLength,
    };
  }
  return { ok: true, sessionId, queueLength: result.queueLength };
}

module.exports = { cancelQueuedScheduledRun, scheduledQueueCapacityBlock, scheduledTaskTurnOptions };
