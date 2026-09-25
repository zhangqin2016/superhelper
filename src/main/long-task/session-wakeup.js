"use strict";

const crypto = require("node:crypto");
const { outcomeObserved } = require("./store");

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

function sameScope(wake, job) {
  return Boolean(job?.turnId) && job.id === wake.jobId && job.turnId === wake.turnId
    && job.sessionId === wake.sessionId && job.projectId === wake.projectId && job.ownerScope === wake.ownerScope;
}

/** The session cannot take a wake turn right now: a turn is running or queued. */
function sessionBusy(ctx, sessionId) {
  try {
    const snapshot = ctx.turnOrchestrator?.snapshot?.(sessionId);
    if (!snapshot || typeof snapshot !== "object") return false;
    return snapshot.phase !== "idle" || Number(snapshot.queueLength) > 0;
  } catch {
    return false;
  }
}

function jobLines(job) {
  const outputs = Array.isArray(job.outputFiles) && job.outputFiles.length
    ? `\n  Expected outputs:\n${job.outputFiles.map((file) => `  - ${file}`).join("\n")}`
    : "";
  return `- Job id: ${job.id} — terminal state: ${job.status || "outcome_unknown"}${job.exitCode == null ? "" : ` (exit ${job.exitCode})`}${outputs}`;
}

/**
 * The wake text depends on where the task stands. A turn that already gave
 * its final answer is not resumed: its jobs are reported, briefly. Before
 * this, every wake re-sent the original request with "continue the original
 * task", and a wake after a finished task spent eight minutes re-verifying it.
 */
function wakeText(source, jobs) {
  const answered = source.terminalType === "turn.completed" || source.status === "completed";
  const many = jobs.length > 1;
  return [
    source.userText,
    `${many ? `${jobs.length} durable background processes` : "A durable background process"} started by this conversation reached terminal state:`,
    ...jobs.map(jobLines),
    `Original turn id: ${jobs[0].turnId}`,
    answered
      ? "That turn already delivered its final answer. Inspect each job's real outcome with lily_process_jobs (job_status, job_logs) and report it to the user briefly, in the user's language. Do not redo or re-verify work that answer already covered; if an outcome contradicts it, say exactly what changed. Do not start the same job again."
      : "Inspect their logs and declared outputs with lily_process_jobs. If they succeeded, verify and continue the original task. If one failed or its outcome is unknown, diagnose conservatively and recover only when replay is safe. Give the user the real outcome. Do not blindly start the same job again.",
  ].filter(Boolean).join("\n");
}

function createLongTaskWakeHandler(ctx) {
  return async (wake, job, extras = {}) => {
    if (!sameScope(wake, job)) return { ok: false, permanent: true, error: "JOB_SCOPE_CHANGED" };
    // The conversation read this outcome already (store.recordOutcomeObserved):
    // the wake has nothing to bring. Retired before any budget is touched.
    if (outcomeObserved(job)) return { ok: false, permanent: true, error: "JOB_OUTCOME_OBSERVED" };
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
    // A running or queued turn may read the outcome itself; the wake waits
    // (the supervisor retries with backoff) and is retired if it did. Nothing
    // is queued behind the user's own messages any more.
    if (sessionBusy(ctx, wake.sessionId)) return { ok: false, permanent: false, defer: true, error: "SESSION_BUSY" };
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
    } catch {
      return { ok: false, permanent: false, error: "TASK_CONTINUATION_STATE_UNAVAILABLE" };
    }
    // Siblings: other wakes of the same turn, claimed together. Those whose
    // outcome was read are retired; the rest ride this one turn.
    const retired = [];
    const carried = [];
    const jobs = [job];
    const withSiblings = (result) => ({ ...result, ...(retired.length ? { retired } : {}), ...(carried.length && result.ok ? { carried } : {}) });
    for (const sibling of Array.isArray(extras.siblings) ? extras.siblings : []) {
      if (!sibling?.wake || !sameScope(sibling.wake, sibling.job) || sibling.job.turnId !== job.turnId
        || sibling.job.replayPolicy === "never") continue;
      if (outcomeObserved(sibling.job)) { retired.push(sibling.wake.id); continue; }
      carried.push(sibling.wake.id);
      jobs.push(sibling.job);
    }
    try {
      if (typeof manager.reserveTaskContinuation !== "function") {
        return withSiblings({ ok: false, permanent: true, error: "TASK_CONTINUATION_BUDGET_UNAVAILABLE" });
      }
      const reservation = manager.reserveTaskContinuation(wake.sessionId, {
        sourceTurnId: job.turnId,
        continuationTurnId: wakeTurnId(wake.id),
        progressKeys: [...new Set(jobs.flatMap(progressKeys))],
      });
      if (!reservation?.ok) {
        return withSiblings({ ok: false, permanent: true, error: reservation?.reason || "TASK_CONTINUATION_BUDGET_UNAVAILABLE" });
      }
    } catch {
      // The supervisor has a bounded retry policy. No send follows an unknown
      // reservation outcome, and a retry reuses the same durable admission ID.
      return withSiblings({ ok: false, permanent: false, error: "TASK_CONTINUATION_STATE_UNAVAILABLE" });
    }
    const result = await ctx.turnOrchestrator.sendUserMessage(
      wake.sessionId,
      source.userText,
      [],
      {
        engineText: wakeText(source, jobs),
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
    return withSiblings(result?.ok ? { ok: true, duplicate: Boolean(result.duplicate) } : { ...result });
  };
}

module.exports = { createLongTaskWakeHandler, wakeTurnId,
  createLongTaskPauseHandler: require("./session-wake-notice").createLongTaskPauseHandler };
