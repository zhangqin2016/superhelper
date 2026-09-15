"use strict";

/**
 * Deleting a conversation is a TASK boundary, not just a UI removal.
 *
 * Fences every automatic lane that could otherwise keep working for a
 * conversation nobody can see any more: pending parent-closure continuations
 * (+ the durable continuation budget), the model-recovery watch, and the
 * session's durable process jobs. Returns counts so the renderer can say
 * "已停止 N 个后台作业". Every step fails open and is reported.
 */

async function fenceSessionWork(ctx, session, options = {}) {
  const sessionId = String(session?.id || "");
  const summary = { sessionId, continuationsCancelled: false, jobs: { stopped: [], failed: [], total: 0 }, errors: [] };
  if (!sessionId) return summary;
  try {
    const recovery = ctx?.turnOrchestrator?.turnRecoveryRuntime;
    if (typeof recovery?.cancelPendingParentClosures === "function") {
      recovery.cancelPendingParentClosures(sessionId);
      summary.continuationsCancelled = true;
    } else if (typeof ctx?.sessionManager?.cancelPendingParentClosureRecoveries === "function") {
      ctx.sessionManager.cancelPendingParentClosureRecoveries(sessionId);
      summary.continuationsCancelled = true;
    }
  } catch (error) {
    summary.errors.push(`continuations: ${error?.message || error}`);
  }
  try {
    const owner = ctx?.sessionManager?.resolveTurnOwnerScope?.(sessionId);
    const ownerScope = owner?.ok ? owner.ownerScope : "";
    if (ownerScope) {
      const dbPath = options.dbPath || require("./config").longTaskDbPath();
      const { stopJobsForSession } = require("./long-task/session-cleanup");
      const stopped = await stopJobsForSession({ dbPath, ownerScope, sessionId, projectId: String(session.projectId || ""), graceMs: options.graceMs });
      summary.jobs = { stopped: stopped.stopped, failed: stopped.failed, total: stopped.total };
      if (stopped.error) summary.errors.push(`jobs: ${stopped.error}`);
    }
  } catch (error) {
    summary.errors.push(`jobs: ${error?.message || error}`);
  }
  return summary;
}

module.exports = { fenceSessionWork };
