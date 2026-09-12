"use strict";

const crypto = require("node:crypto");

function wakeTurnId(wakeId) {
  const digest = crypto.createHash("sha256").update(String(wakeId || ""), "utf8").digest("hex");
  return `turn_long_task_${digest.slice(0, 32)}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function progressKeys(job) {
  if (job.status !== "succeeded" || job.exitCode !== 0) return [];
  // A new process ID, observation timestamp or progress sequence is not new
  // work. Only stable successful result facts can qualify another continuation.
  const receipt = stableValue({
    command: job.command || "", args: job.args || [], cwd: job.cwd || "",
    status: job.status, exitCode: job.exitCode, progress: job.progress || {},
    outputFiles: Array.isArray(job.outputFiles) ? [...job.outputFiles].sort() : [],
  });
  return [crypto.createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex")];
}

function createLongTaskWakeHandler(ctx) {
  return async (wake, job) => {
    if (!job?.turnId || job.id !== wake.jobId || job.turnId !== wake.turnId
      || job.sessionId !== wake.sessionId || job.projectId !== wake.projectId || job.ownerScope !== wake.ownerScope) {
      return { ok: false, permanent: true, error: "JOB_SCOPE_CHANGED" };
    }
    const session = ctx.sessionManager?.findById?.(wake.sessionId);
    if (!session) return { ok: false, permanent: true, error: "SESSION_NOT_FOUND" };
    if (String(session.projectId || "") !== wake.projectId) {
      return { ok: false, permanent: true, error: "PROJECT_SCOPE_CHANGED" };
    }
    const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(wake.sessionId);
    if (!owner?.ok || owner.ownerScope !== wake.ownerScope) {
      return { ok: false, permanent: true, error: "OWNER_SCOPE_CHANGED" };
    }
    if (job.replayPolicy === "never") return { ok: false, permanent: true, error: "JOB_REPLAY_FORBIDDEN" };
    const manager = ctx.sessionManager;
    let source;
    try {
      source = manager.getTurnInputByTurnId?.(wake.sessionId, job.turnId);
      if (!source || source.sessionId !== wake.sessionId || source.turnId !== job.turnId
        || source.ownerScope !== wake.ownerScope || typeof source.userText !== "string" || !source.userText.trim()) {
        return { ok: false, permanent: true, error: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
      }
      if (["cancelled", "interrupted"].includes(source.status)
        || ["turn.cancelled", "turn.interrupted"].includes(source.terminalType)) {
        return { ok: false, permanent: true, error: "TASK_CONTINUATION_CANCELLED" };
      }
      if (typeof manager.reserveTaskContinuation !== "function") {
        return { ok: false, permanent: true, error: "TASK_CONTINUATION_BUDGET_UNAVAILABLE" };
      }
      const reservation = manager.reserveTaskContinuation(wake.sessionId, {
        sourceTurnId: job.turnId,
        continuationTurnId: wakeTurnId(wake.id),
        progressKeys: progressKeys(job),
      });
      if (!reservation?.ok) {
        return { ok: false, permanent: true, error: reservation?.reason || "TASK_CONTINUATION_BUDGET_UNAVAILABLE" };
      }
    } catch {
      // The supervisor has a bounded retry policy. No send follows an unknown
      // reservation outcome, and a retry reuses the same durable admission ID.
      return { ok: false, permanent: false, error: "TASK_CONTINUATION_STATE_UNAVAILABLE" };
    }
    const outputs = Array.isArray(job.outputFiles) && job.outputFiles.length
      ? `\nExpected outputs:\n${job.outputFiles.map((file) => `- ${file}`).join("\n")}`
      : "";
    const engineText = [
      source.userText,
      `A durable background process started by this conversation reached terminal state: ${job.status || "outcome_unknown"}.`,
      `Job id: ${job.id}`,
      `Original turn id: ${job.turnId}`,
      outputs,
      "Inspect its logs and declared outputs with lily_process_jobs. If it succeeded, verify and continue the original task. If it failed or its outcome is unknown, diagnose conservatively and recover only when replay is safe. Give the user the real outcome. Do not blindly start the same job again.",
    ].filter(Boolean).join("\n");
    const result = await ctx.turnOrchestrator.sendUserMessage(
      wake.sessionId,
      source.userText,
      [],
      {
        engineText,
        recordUser: false,
        nonInteractive: true,
        queueOrigin: "long_task",
        queueVisibility: "background",
        skipDocument: true,
        skipVision: true,
        turnId: wakeTurnId(wake.id),
        durableQueueKey: wake.id,
        sourceTurnId: job.turnId,
        sourceTaskCore: source.taskCore || null,
      },
    );
    return result?.ok ? { ok: true, duplicate: Boolean(result.duplicate) } : result;
  };
}

module.exports = { createLongTaskWakeHandler, wakeTurnId,
  createLongTaskPauseHandler: require("./session-wake-notice").createLongTaskPauseHandler };
