"use strict";

const { buildTaskPrompt } = require("./schedule-parser");

function dispatchScheduledRun({
  ctx,
  task,
  run,
  nonInteractive,
  markRunStarted,
  finishRun,
  saveRun,
  onSettled,
}) {
  let resultPromise;
  try {
    resultPromise = ctx.turnOrchestrator.sendUserMessage(task.executionSessionId, buildTaskPrompt(task), [], {
      recordUser: true,
      spawnEngine: true,
      scheduledTaskId: task.id,
      scheduledTaskRunId: run.id,
      scheduledTaskTitle: task.title,
      nonInteractive: nonInteractive === true,
      queueOrigin: "scheduled_task",
      queueVisibility: "background",
    });
  } catch (err) {
    finishRun(run, "turn.failed", { error: err?.message });
    onSettled();
    return;
  }
  Promise.resolve(resultPromise).then((result) => {
    if (!result?.ok) {
      finishRun(run, "turn.failed", { error: result?.detail || result?.error });
      return;
    }
    if (result.queued) run.queueItemId = result.itemId || null;
    else markRunStarted(run.id, result.turnId);
    saveRun(run);
  }).catch((err) => finishRun(run, "turn.failed", { error: err?.message }))
    .finally(onSettled);
}

function interruptForeignScheduledRun(ctx, run, completeRun) {
  if (run.status === "queued") {
    const cancelled = ctx?.turnOrchestrator?.cancelQueuedScheduledRun?.(run.sessionId, run.id);
    if (!cancelled?.ok) completeRun(run.id, "turn.interrupted", { errorCode: "ACCOUNT_CHANGED" });
    return;
  }
  try {
    ctx?.turnOrchestrator?.interrupt?.(run.sessionId, { clearQueue: false });
  } catch {
    // Database completion remains authoritative if the runner already exited.
  }
  completeRun(run.id, "turn.interrupted", { errorCode: "ACCOUNT_CHANGED" });
}

module.exports = { dispatchScheduledRun, interruptForeignScheduledRun };
