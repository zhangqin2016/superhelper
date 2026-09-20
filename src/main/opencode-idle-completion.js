"use strict";

const { captureExecutionScope } = require("./opencode-execution-scope");

async function confirmIdleAndComplete(runner) {
  const next = runner._pendingCompletePayload;
  if (!next || runner._turnSettled) return;
  const isCurrent = captureExecutionScope(runner);
  const status = await runner._getSessionStatus();
  if (!isCurrent() || runner._pendingCompletePayload !== next) return;
  if (status !== "idle") {
    runner._scheduleCompleteTurn(next);
    return;
  }
  const synced = await runner._syncFinalOutputFromOfficialHistory({
    ...next, output: runner.collectedOutput.trim(),
  });
  if (!isCurrent() || runner._pendingCompletePayload !== next) return;
  runner._pendingCompletePayload = null;
  if (await runner._replayEmptyCompletionIfSafe(synced)) return;
  if (!isCurrent()) return;
  runner._completeTurn(synced);
}

async function probeOfficialIdleAndComplete(runner) {
  if (!runner.busy || runner._turnSettled || runner._pendingCompletePayload) return;
  if (runner._pendingPermissions.size || runner._pendingQuestions.size) {
    runner._armIdleProbe();
    return;
  }
  const isCurrent = captureExecutionScope(runner);
  const status = await runner._getSessionStatus();
  if (!isCurrent() || !runner.busy || runner._pendingCompletePayload) return;
  if (runner._pendingPermissions.size || runner._pendingQuestions.size || status !== "idle") {
    runner._armIdleProbe();
    return;
  }
  // Reconcile a dropped SSE idle event with the authoritative session state.
  runner._scheduleCompleteTurn({
    code: 0, output: runner.collectedOutput.trim(), interrupted: false, completedByIdleProbe: true,
  });
}

module.exports = { confirmIdleAndComplete, probeOfficialIdleAndComplete };
