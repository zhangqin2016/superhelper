"use strict";

const { engineNotice } = require("../shared/engine-notices.mjs");

/**
 * Durable "the continuation stopped / did not start" record for a long task.
 *
 * Before 2026-09-15 a continuation denial or an exhausted continuation budget
 * was only an ephemeral panel notice without a turn id, so it never reached the
 * archived conversation: the user scrolled back and saw a task that simply
 * ended. The process-job lane already commits a real assistant message for the
 * same reasons (long-task/session-wake-notice.js); this does the same for the
 * parent-closure lane. Idempotent per (session, source turn, reason), never
 * replaces the source answer, fail-open.
 */

const crypto = require("node:crypto");

const HINTS = {
  "zh-CN": "发送「继续」即可在本对话接着做，Lily 会带上已改文件、已跑命令和待办清单；平台不会自行无限重试。",
  en: "Send \"continue\" to pick this up in the same conversation — Lily brings the files changed, commands run, and the todo list. It will not retry forever on its own.",
  ar: "أرسل «متابعة» لاستئناف العمل في المحادثة نفسها؛ ستحمل Lily الملفات المعدّلة والأوامر المنفّذة وقائمة المهام، ولن تعيد المحاولة بلا حدود من تلقاء نفسها.",
};
const CONTINUE_HINT = HINTS["zh-CN"];

function budgetRounds() {
  try { return require("./store/task-continuation-budget").MAX_ROUNDS; } catch { return 8; }
}
function minProgress() {
  try { return require("./store/task-continuation-budget").minProgressPerRound(); } catch { return 3; }
}

const TEXT = {
  "zh-CN": {
    stoppedTitle: "自动接续已停止",
    notStartedTitle: "本轮未完成，未自动接续",
    budget: (n) => `本任务已达到 ${n} 次自动接续上限（24 小时内）。已完成的进展已保留，剩余工作尚未完成。`,
    deadline: "本任务已达到 24 小时自动接续时限。已完成的进展已保留，剩余工作尚未完成。",
    noProgress: (n) => `上一轮接续没有产生足够的新执行进展（少于 ${n} 条新的成功工具记录），为避免原地重复，已停止自动接续。`,
    modelGaveUp: (n) => `模型在 ${n} 次探测内没有恢复响应，已停止等待。任务进展已保留。换一个模型后发送「继续」即可接着做。`,
    nonExecution: "这类任务不在自动接续范围内（自动接续只用于有执行意图、且已留下工具记录的任务）。",
    noEvidence: "本轮没有留下可确认的执行记录，自动接续无法判断从哪一步接着做。",
  },
  en: {
    stoppedTitle: "Automatic continuation stopped",
    notStartedTitle: "This turn did not finish, and was not continued automatically",
    budget: (n) => `This task reached its limit of ${n} automatic continuations within 24 hours. The progress made is kept; the remaining work is unfinished.`,
    deadline: "This task reached the 24-hour automatic-continuation window. The progress made is kept; the remaining work is unfinished.",
    noProgress: (n) => `The last continuation produced too little new execution progress (fewer than ${n} new successful tool records), so it was stopped rather than repeat itself.`,
    modelGaveUp: (n) => `The model did not respond again within ${n} probes, so waiting stopped. The progress is kept. Switch models and send "continue" to resume.`,
    nonExecution: "This kind of task is out of scope for automatic continuation, which only covers work with execution intent that already left tool records.",
    noEvidence: "This turn left no confirmable execution record, so automatic continuation cannot tell where to resume.",
  },
  ar: {
    stoppedTitle: "توقفت المتابعة التلقائية",
    notStartedTitle: "لم تكتمل هذه الجولة ولم تتم متابعتها تلقائيا",
    budget: (n) => `بلغت هذه المهمة حد ${n} متابعات تلقائية خلال 24 ساعة. التقدّم المحرز محفوظ والعمل المتبقي غير مكتمل.`,
    deadline: "بلغت هذه المهمة نافذة المتابعة التلقائية البالغة 24 ساعة. التقدّم المحرز محفوظ والعمل المتبقي غير مكتمل.",
    noProgress: (n) => `لم تُنتج المتابعة الأخيرة تقدّما تنفيذيا كافيا (أقل من ${n} سجلات أدوات ناجحة جديدة)، فتوقفت بدل التكرار.`,
    modelGaveUp: (n) => `لم يستجب النموذج خلال ${n} محاولات فحص، فتوقّف الانتظار. التقدّم محفوظ. بدّل النموذج وأرسل «متابعة» للاستئناف.`,
    nonExecution: "هذا النوع من المهام خارج نطاق المتابعة التلقائية، التي تغطي فقط العمل التنفيذي الذي ترك سجلات أدوات.",
    noEvidence: "لم تترك هذه الجولة سجل تنفيذ يمكن تأكيده، لذا لا تستطيع المتابعة التلقائية تحديد نقطة الاستئناف.",
  },
};

function localeCopy(locale) {
  const key = String(locale || "zh-CN");
  return TEXT[key] || TEXT[key.slice(0, 2)] || TEXT["zh-CN"];
}

function describe(reason, info = {}, locale = "zh-CN") {
  const c = localeCopy(locale);
  switch (reason) {
    case "TASK_CONTINUATION_BUDGET_EXHAUSTED":
      return { title: c.stoppedTitle, detail: c.budget(budgetRounds()), status: "stopped" };
    case "TASK_CONTINUATION_DEADLINE":
      return { title: c.stoppedTitle, detail: c.deadline, status: "stopped" };
    case "TASK_CONTINUATION_NO_PROGRESS":
      return { title: c.stoppedTitle, detail: c.noProgress(minProgress()), status: "stopped" };
    case "MODEL_RECOVERY_GAVE_UP":
      return { title: c.stoppedTitle, detail: c.modelGaveUp(Number(info.attempts) || 0), status: "stopped" };
    case "NON_EXECUTION_TASK":
      return { title: c.notStartedTitle, detail: c.nonExecution, status: "not_started" };
    case "NO_EXECUTION_EVIDENCE":
      return { title: c.notStartedTitle, detail: c.noEvidence, status: "not_started" };
    default:
      return null;
  }
}

/**
 * @returns {{ ok:boolean, message?:object, skipped?:string }}
 */
function commitParentClosureNotice(ctx, sessionId, { sourceTurnId = "", reason = "", info = {}, locale: requestedLocale = "" } = {}) {
  try {
    if (process.env.LILY_CLOSURE_NOTICE === "0") return { ok: true, skipped: "disabled" };
    let locale = requestedLocale;
    if (!locale) { try { locale = require("./locale-settings").getLocale() || "zh-CN"; } catch { locale = "zh-CN"; } }
    const described = describe(reason, info, locale);
    if (!described || !sessionId || !sourceTurnId) return { ok: true, skipped: "not_applicable" };
    const manager = ctx?.sessionManager;
    if (typeof manager?.findMessage !== "function" || typeof manager?.pushMessageTo !== "function") return { ok: false, skipped: "manager_unavailable" };
    const digest = crypto.createHash("sha256").update(`${sessionId}|${sourceTurnId}|${reason}`).digest("hex");
    const id = `msg_closure_${digest}`;
    let message = manager.findMessage(sessionId, id);
    if (!message) {
      const hint = HINTS[locale] || HINTS[String(locale).slice(0, 2)] || CONTINUE_HINT;
      const content = `${described.title}\n\n${described.detail}\n${hint}`;
      manager.pushMessageTo(sessionId, "assistant", content, null, {
        id,
        // A platform record: it must never replace the source answer or read as
        // completion of the turn it annotates.
        turnId: `turn_closure_notice_${digest}`,
        meta: { taskContinuation: { reason, sourceTurnId, status: described.status, lane: "parent_closure" } },
      });
      message = manager.findMessage(sessionId, id);
      if (!message) return { ok: false, skipped: "not_persisted" };
    }
    if (typeof ctx?.eventBus?.emit === "function") {
      ctx.eventBus.emit(sessionId, {
        type: "engine.warning", turnId: null, source: "parent_closure_recovery",
        payload: { notice: engineNotice("parentClosureStopped"), committedMessage: message },
      });
    }
    return { ok: true, message };
  } catch {
    return { ok: false, skipped: "error" };
  }
}

module.exports = { commitParentClosureNotice, describeParentClosureStop: describe, CONTINUE_HINT };
