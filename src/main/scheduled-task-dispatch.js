"use strict";

const { buildTaskPrompt } = require("./schedule-parser");

function reconcileScheduledRunWithTurn(run, result = {}) {
  const durableStatus = String(result.durableStatus || "");
  run.turnId = result.turnId || run.turnId || null;
  run.dispatchAttemptId = result.dispatchAttemptId || null;
  run.dispatchStartedAt = result.dispatchStartedAt || null;
  run.engineAcceptedAt = result.acceptedAt || null;
  if (durableStatus === "dispatching") {
    run.status = "dispatch_unknown";
  } else if (durableStatus === "outcome_unknown") {
    run.status = "dispatch_unknown";
  } else if (durableStatus === "promoted" || durableStatus === "accepted") {
    run.status = "promoted";
  } else if (durableStatus === "completed") {
    run.status = "succeeded";
  } else if (durableStatus === "failed" || durableStatus === "interrupted") {
    run.status = durableStatus === "interrupted" ? "interrupted" : "failed";
  }
  if (["succeeded", "failed", "interrupted"].includes(run.status)) {
    run.finishedAt = Number.isFinite(result.terminalAt)
      ? new Date(result.terminalAt).toISOString()
      : result.terminalAt || run.finishedAt || null;
    run.leaseExpiresAt = null;
    run.error = run.status === "succeeded"
      ? null
      : result.errorCode || result.terminalType || run.error || null;
  }
  return run;
}

function reconcileScheduledRunsWithDurableTurns(
  ctx,
  runs,
  tasks,
  store,
  currentPrincipal,
) {
  const lookup = ctx?.sessionManager?.findTurnInputByScheduledRun;
  if (typeof lookup !== "function") return 0;
  let reconciled = 0;
  for (const run of runs || []) {
    if (run.ownerPrincipal !== currentPrincipal) continue;
    if (!["queued", "running", "dispatch_unknown", "promoted"].includes(run.status)) {
      continue;
    }
    let turn;
    try {
      turn = lookup.call(ctx.sessionManager, run.sessionId, run.id);
    } catch {
      continue;
    }
    if (!turn) continue;
    reconcileScheduledRunWithTurn(run, {
      durableStatus: turn.status,
      turnId: turn.turnId,
      dispatchAttemptId: turn.dispatchAttemptId,
      dispatchStartedAt: turn.dispatchStartedAt,
      acceptedAt: turn.acceptedAt || turn.promotedAt,
      terminalAt: turn.terminalAt,
      terminalType: turn.terminalType,
      errorCode: turn.errorCode,
    });
    store?.saveRun(run);
    const task = (tasks || []).find((item) => item.id === run.taskId);
    if (task) {
      const terminal = ["succeeded", "failed", "interrupted"].includes(run.status);
      task.status = terminal
        ? task.enabled ? "scheduled" : "paused"
        : run.status === "queued" ? "queued" : "running";
      if (terminal) task.lastRunAt = run.finishedAt;
      store?.saveTask(task);
    }
    reconciled += 1;
  }
  return reconciled;
}

function dispatchScheduledRun({
  ctx,
  task,
  run,
  nonInteractive,
  markRunStarted,
  reconcileRun = reconcileScheduledRunWithTurn,
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
    if (result.duplicate) {
      reconcileRun(run, result);
      saveRun(run);
      return;
    }
    if (result.queued) run.queueItemId = result.itemId || null;
    else markRunStarted(run.id, result.turnId);
    saveRun(run);
  }).catch((err) => finishRun(run, "turn.failed", { error: err?.message }))
    .finally(onSettled);
}

function interruptForeignScheduledRun(ctx, run) {
  if (run.status === "queued" || run.status === "dispatch_unknown") return;
  ctx?.turnOrchestrator?.interruptScheduledRun?.(run);
}

module.exports = {
  dispatchScheduledRun,
  interruptForeignScheduledRun,
  reconcileScheduledRunWithTurn,
  reconcileScheduledRunsWithDurableTurns,
};
