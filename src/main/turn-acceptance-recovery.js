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
  if (type === "turn.completed" && state.taskRequest?.complete === false) return finish({ status: "unknown", reason: state.taskRequest.reason || "request_source_incomplete", requirements: [] });
  if (type === "turn.completed" && state.taskRun && state.tools?.size && hasExecutionIntent(state.taskContract)) return Promise.resolve().then(() => assess({ state })).catch(() => ({ status: "unknown", requirements: [] })).then(finish);
  return finish(null);
  function finish(coverage) {
  // Never attach old asynchronous results to a newer turn or a cancellation.
  if (state.turnId !== sourceTurnId) return null;
  taskRunRuntime?.complete?.(sessionId, type, { ...completeOptions, workspacePath, objectiveCoverage: coverage });
  if (type !== "turn.completed" || !terminalPersisted || specializedRecovery || !state.taskRun) return null;
  // Template criteria are audit observations, not additional user requests.
  // Unknown evidence (including an unavailable judge) must not manufacture
  // work such as renderer testing for a one-shot shell command. Only grounded
  // missing requirements, declared files, or native productive handoffs recover.
  const unfinished = [];
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
