"use strict";
const { originalAcceptance, assessObjectiveCoverage } = require("./task-original-acceptance");
const { inspectDeliverables } = require("./task-delivery-manifest");
const { captureParentClosureSource } = require("./turn-parent-closure-runtime");
const { shouldRecoverParentClosure, hasExecutionIntent } = require("./parent-task-closure");

function workspaceFor(ctx, sessionId) {
  try {
    const session = ctx.sessionManager?.findById?.(sessionId);
    return ctx.sessionManager?.pm?.find?.(session?.projectId)?.path || session?.workspacePath || "";
  } catch { return ""; }
}

function completeWithAcceptance({ ctx = {}, sessionId, state, type, payload, taskRunRuntime, completeOptions = {}, specializedRecovery = false, terminalPersisted = false, prepare, assess = assessObjectiveCoverage }) {
  const sourceTurnId = state.turnId;
  const workspacePath = workspaceFor(ctx, sessionId);
  // Failure/cancellation must retain the synchronous terminal projection; an
  // added microtask here would drop the outcome-unknown assistant event.
  if (type === "turn.completed" && state.taskRun && state.tools?.size && hasExecutionIntent(state.taskContract)) return Promise.resolve().then(() => assess({ state })).catch(() => ({ status: "unknown", requirements: [] })).then(finish);
  return finish(null);
  function finish(coverage) {
  // Never attach old asynchronous results to a newer turn or a cancellation.
  if (state.turnId !== sourceTurnId) return null;
  taskRunRuntime?.complete?.(sessionId, type, { ...completeOptions, workspacePath, objectiveCoverage: coverage });
  if (type !== "turn.completed" || !terminalPersisted || specializedRecovery || !state.taskRun) return null;
  const verification = state.taskRun.verification || {};
  const unfinished = (verification.criteria || []).filter(item => ["unverified", "not_observed"].includes(item.status))
    .map(item => ({ title: item.criterion, status: "pending", kind: "verification" }));
  if (verification.reason === "missing_test_or_build_evidence" && !unfinished.length) unfinished.push({ title: "Run the task's focused verification after the final edits and retain the actual exit status.", status: "pending", kind: "verification" });
  const manifest = inspectDeliverables(originalAcceptance(state).deliverables, workspacePath);
  for (const file of manifest) {
    if (file.repairable && ["missing", "empty"].includes(file.status)) unfinished.push({ title: `Complete and verify the declared output: ${file.path}`, status: "pending", kind: "delivery" });
  }
  for (const requirement of coverage?.requirements || []) {
    if (requirement.status === "missing") unfinished.push({ title: requirement.title, status: "pending", kind: "original_requirement" });
  }
  const handoff = unfinished.length ? { schemaVersion: 1, reason: "acceptance_gap", unfinished: unfinished.slice(0, 32) } : payload.continuationHandoff;
  if (!handoff) return null;
  const source = captureParentClosureSource(state, { ...payload, code: 0, continuationHandoff: handoff });
  if (!shouldRecoverParentClosure({ sessionId, ...source }).ok) return null;
  prepare?.(sessionId, source);
  return source;
  }
}

module.exports = { completeWithAcceptance };
