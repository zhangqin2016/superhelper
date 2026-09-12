"use strict";

const crypto = require("node:crypto");

const DETAILS = {
  TASK_CONTINUATION_NO_PROGRESS: "未观察到新的跨轮执行进展，为避免重复执行，已暂停自动接续。",
  TASK_CONTINUATION_BUDGET_EXHAUSTED: "本次任务已达到 8 次自动接续上限。",
  TASK_CONTINUATION_DEADLINE: "本次任务已达到 24 小时自动接续时限。",
  TASK_CONTINUATION_SOURCE_UNAVAILABLE: "暂时无法确认原任务的完整要求，未自动继续执行。",
};
const SILENT = new Set(["AUTO_WAKE_DISABLED", "TASK_CONTINUATION_CANCELLED", "SESSION_NOT_FOUND",
  "OWNER_SCOPE_CHANGED", "PROJECT_SCOPE_CHANGED", "JOB_SCOPE_CHANGED", "JOB_REPLAY_FORBIDDEN"]);

function createLongTaskPauseHandler(ctx) {
  return async (wake, job) => {
    if (!wake || !job || wake.status !== "abandoned" || SILENT.has(wake.lastError)) return { ok: true };
    if (job.id !== wake.jobId || job.ownerScope !== wake.ownerScope || job.sessionId !== wake.sessionId
      || job.projectId !== wake.projectId || job.turnId !== wake.turnId) return { ok: true };
    const manager = ctx.sessionManager;
    const session = manager.findById(wake.sessionId);
    if (!session || String(session.projectId || "") !== wake.projectId) return { ok: true };
    const owner = manager.resolveTurnOwnerScope(wake.sessionId);
    if (!owner?.ok) return { ok: false };
    if (owner.ownerScope !== wake.ownerScope) return { ok: true };
    if (typeof manager.findMessage !== "function" || typeof manager.pushMessageTo !== "function"
      || typeof ctx.eventBus?.emit !== "function") return { ok: false };

    const digest = crypto.createHash("sha256").update(wake.id).digest("hex");
    const id = `msg_task_pause_${digest}`;
    let message = manager.findMessage(wake.sessionId, id);
    if (!message) {
      const reason = Object.hasOwn(DETAILS, wake.lastError) ? wake.lastError : "TASK_CONTINUATION_UNAVAILABLE";
      const current = job.progress?.current ?? job.progress?.done;
      const total = job.progress?.total;
      const progress = Number.isFinite(current) && current >= 0
        ? `\n最近记录的进度：${current}${Number.isFinite(total) && total >= current ? ` / ${total}` : ""}。`
        : "";
      const detail = DETAILS[reason] || "自动接续未能启动，已暂停，未重复派发任务。";
      const content = `任务接续已暂停\n\n${detail}${progress}\n整个任务尚未验证完成；现有记录已保留。可查看已有结果，并明确发送继续原任务的要求；平台不会自行无限重试。`;
      manager.pushMessageTo(wake.sessionId, "assistant", content, null, {
        id,
        // A separate platform record must never replace the source answer or
        // masquerade as completion of the currently running turn.
        turnId: `turn_task_pause_${digest}`,
        meta: { taskContinuation: { reason, jobId: job.id, sourceTurnId: job.turnId, status: "paused" } },
      });
      message = manager.findMessage(wake.sessionId, id);
      if (!message) return { ok: false };
    }
    ctx.eventBus.emit(wake.sessionId, {
      type: "engine.warning", turnId: null, source: "long_task_supervisor",
      payload: { notice: { code: "taskContinuationPaused", level: "warning", panel: true }, committedMessage: message },
    });
    return { ok: true };
  };
}

module.exports = { createLongTaskPauseHandler };
