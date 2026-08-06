"use strict";

const { getLogger } = require("./logger");
const { emitLifecycle } = require("./task-lifecycle-runtime");

const log = getLogger("task-result-runtime");

function persistTerminalTaskResult({ ctx, sessionId, turnId, type, state } = {}) {
  if (!state?.taskRun || typeof ctx.sessionManager?.persistTaskResult !== "function") return false;
  try {
    const result = ctx.sessionManager.persistTaskResult(sessionId, {
      taskId: state.taskRun.id || state.contextSnapshot?.taskId || turnId,
      turnId,
      attemptId: state.dispatchAttemptId || state.taskRun.resumeState?.leadAttemptId || null,
      terminalType: type,
      verification: state.taskRun.verification || {
        status: "not_verified",
        reason: "task_terminal_without_verification",
      },
    });
    if (result?.ok) return true;
    log.error("task result persistence failed: session=%s turn=%s reason=%s", sessionId, turnId, result?.reason || "unknown");
  } catch (error) {
    log.error("task result persistence threw: session=%s turn=%s error=%s", sessionId, turnId, error?.message || error);
  }
  return false;
}

function markTerminalTaskResultDelivered({ ctx, sessionId, turnId, type, messageId, persisted, state } = {}) {
  const manager = ctx.sessionManager;
  if (!persisted && typeof manager?.transitionTaskLifecycle !== "function") return;
  try {
    const delivery = {
      terminalType: type,
      messageId: messageId || "",
      archived: Boolean(messageId),
      emitted: true,
    };
    if (persisted && typeof manager?.markTaskResultDelivered === "function") {
      manager.markTaskResultDelivered(sessionId, turnId, delivery);
    }
    if (typeof manager?.markTaskLifecycleDelivered === "function") {
      const lifecycleResult = manager.markTaskLifecycleDelivered(sessionId, {
        taskId: state?.lifecycleTaskId || state?.taskRun?.id || turnId,
        turnId,
        delivery,
      });
      if (lifecycleResult?.ok && !lifecycleResult.idempotent) emitLifecycle(ctx, sessionId, lifecycleResult.lifecycle);
    } else if (typeof manager?.transitionTaskLifecycle === "function") {
      manager.transitionTaskLifecycle(sessionId, {
        taskId: state?.lifecycleTaskId || state?.taskRun?.id || turnId,
        turnId,
        fromStatuses: ["verified", "observed", "unverified", "blocked", "not_required"],
        status: "delivered",
        delivery,
      });
    }
  } catch (error) {
    log.error("task delivery persistence threw: session=%s turn=%s error=%s", sessionId, turnId, error?.message || error);
  }
}

module.exports = { markTerminalTaskResultDelivered, persistTerminalTaskResult };
