"use strict";

const crypto = require("node:crypto");

function wakeTurnId(wakeId) {
  const digest = crypto.createHash("sha256").update(String(wakeId || ""), "utf8").digest("hex");
  return `turn_long_task_${digest.slice(0, 32)}`;
}

function createLongTaskWakeHandler(ctx) {
  return async (wake, job) => {
    const session = ctx.sessionManager?.findById?.(wake.sessionId);
    if (!session) return { ok: false, permanent: true, error: "SESSION_NOT_FOUND" };
    if (String(session.projectId || "") !== wake.projectId) {
      return { ok: false, permanent: true, error: "PROJECT_SCOPE_CHANGED" };
    }
    const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(wake.sessionId);
    if (!owner?.ok || owner.ownerScope !== wake.ownerScope) {
      return { ok: false, permanent: true, error: "OWNER_SCOPE_CHANGED" };
    }
    const outputs = Array.isArray(job.outputFiles) && job.outputFiles.length
      ? `\nExpected outputs:\n${job.outputFiles.map((file) => `- ${file}`).join("\n")}`
      : "";
    const engineText = [
      `A durable background process started by this conversation reached terminal state: ${job.status || "succeeded"}.`,
      `Job id: ${job.id}`,
      `Original turn id: ${job.turnId}`,
      outputs,
      "Inspect its logs and declared outputs with lily_process_jobs. If it succeeded, verify and continue the original task. If it failed or its outcome is unknown, diagnose conservatively and recover only when replay is safe. Give the user the real outcome. Do not blindly start the same job again.",
    ].filter(Boolean).join("\n");
    const result = await ctx.turnOrchestrator.sendUserMessage(
      wake.sessionId,
      `Continue completed background job ${job.id}`,
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
      },
    );
    return result?.ok ? { ok: true, duplicate: Boolean(result.duplicate) } : result;
  };
}

module.exports = { createLongTaskWakeHandler, wakeTurnId };
