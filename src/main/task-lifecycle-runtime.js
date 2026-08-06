"use strict";

function taskIdFor(state) {
  return String(state?.lifecycleTaskId || state?.taskRun?.id || state?.taskCore?.taskId || state?.turnId || "");
}

function taskIdentity(state) {
  return {
    taskId: taskIdFor(state),
    turnId: String(state?.turnId || ""),
  };
}

function ensureTaskLifecycle(ctx, sessionId, state, patch = {}) {
  const manager = ctx?.sessionManager;
  if (typeof manager?.ensureTaskLifecycle !== "function") return null;
  const identity = taskIdentity(state);
  if (!identity.taskId || !identity.turnId) return null;
  try {
    const result = manager.ensureTaskLifecycle(sessionId, { ...identity, ...patch });
    if (result?.ok && !result.idempotent) emitLifecycle(ctx, sessionId, result.lifecycle);
    return result;
  } catch {
    return null;
  }
}

function transitionTaskLifecycle(ctx, sessionId, state, status, patch = {}) {
  const manager = ctx?.sessionManager;
  if (typeof manager?.transitionTaskLifecycle !== "function") return null;
  const identity = taskIdentity(state);
  if (!identity.taskId || !identity.turnId || !status) return null;
  try {
    const result = manager.transitionTaskLifecycle(sessionId, {
      ...identity,
      status,
      ...patch,
    });
    if (result?.ok) emitLifecycle(ctx, sessionId, result.lifecycle);
    return result;
  } catch {
    return null;
  }
}

function emitLifecycle(ctx, sessionId, lifecycle) {
  if (!lifecycle || typeof ctx?.eventBus?.emit !== "function") return;
  try {
    ctx.eventBus.emit(sessionId, {
      type: "task.lifecycle.updated",
      turnId: lifecycle.turnId,
      source: "task-lifecycle",
      payload: {
        taskId: lifecycle.taskId,
        status: lifecycle.status,
        version: lifecycle.version,
        deliveryStatus: lifecycle.deliveryStatus,
        graphId: lifecycle.graphId || "",
        attemptId: lifecycle.attemptId || "",
        checkpointId: lifecycle.checkpointId || "",
        processJobId: lifecycle.processJobId || "",
        verification: lifecycle.verification || {},
        delivery: lifecycle.delivery || {},
      },
    });
  } catch {
    // Persistence remains authoritative if a renderer projection fails.
  }
}

function verificationLifecycleStatus(verification = {}) {
  const status = String(verification?.status || "not_required");
  return new Set(["verified", "observed", "unverified", "blocked", "not_required"]).has(status)
    ? status
    : "unverified";
}

function completeShortTurnLifecycle(ctx, sessionId, state, type, payload = {}) {
  if (state?.taskRun) return;
  if (type === "turn.completed") {
    transitionTaskLifecycle(ctx, sessionId, state, "verifying");
    transitionTaskLifecycle(ctx, sessionId, state, "not_required", {
      verification: { status: "not_required", reason: "ordinary_turn_without_task_run" },
    });
  } else if (type === "turn.stalled" || payload.errorCode === "DISPATCH_OUTCOME_UNKNOWN") {
    transitionTaskLifecycle(ctx, sessionId, state, "outcome_unknown", { metadata: { terminalType: type } });
  } else if (type === "turn.interrupted") {
    transitionTaskLifecycle(ctx, sessionId, state, "cancelled", { metadata: { terminalType: type } });
  } else {
    transitionTaskLifecycle(ctx, sessionId, state, "failed", { metadata: { terminalType: type } });
  }
}

module.exports = {
  emitLifecycle,
  completeShortTurnLifecycle,
  ensureTaskLifecycle,
  taskIdFor,
  taskIdentity,
  transitionTaskLifecycle,
  verificationLifecycleStatus,
};
