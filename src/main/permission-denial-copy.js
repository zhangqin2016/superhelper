"use strict";

const { engineNotice } = require("../shared/engine-notices.mjs");

/**
 * Why an operation was refused without asking.
 *
 * "仅规划" mode and unattended internal turns auto-reject instead of showing a
 * card. Until 2026-09-15 that rejection was silent: the engine turned it into a
 * generic "Unable to read <path>", the model reported 无法访问, and the user had
 * no way to know a mode had refused it rather than the file being unreadable.
 */

const TOOLS = {
  "zh-CN": {
    external_directory: "访问工作区之外的目录",
    bash: "执行命令",
    edit: "修改文件",
    write: "写入文件",
    patch: "修改文件",
    generic: "这个操作",
  },
  en: {
    external_directory: "access a directory outside the workspace",
    bash: "run a command",
    edit: "modify a file",
    write: "write a file",
    patch: "modify a file",
    generic: "this operation",
  },
  ar: {
    external_directory: "الوصول إلى مجلد خارج مساحة العمل",
    bash: "تنفيذ أمر",
    edit: "تعديل ملف",
    write: "كتابة ملف",
    patch: "تعديل ملف",
    generic: "هذه العملية",
  },
};

const REASONS = {
  "zh-CN": {
    plan: (what) => `已按「仅规划」模式拒绝${what}。切换到「确认后执行」或「全自主」后可以继续。`,
    nonInteractive: (what) => `本轮为平台自动执行，无法弹出确认框，已拒绝${what}。`,
    other: (what) => `当前权限模式已拒绝${what}。`,
  },
  en: {
    plan: (what) => `Plan-only mode refused to ${what}. Switch to confirm-then-act or autonomous to allow it.`,
    nonInteractive: (what) => `This was an automatic internal turn with no way to show a prompt, so it refused to ${what}.`,
    other: (what) => `The current permission mode refused to ${what}.`,
  },
  ar: {
    plan: (what) => `رفض وضع «التخطيط فقط» ${what}. بدّل إلى التأكيد قبل التنفيذ أو الوضع المستقل للسماح به.`,
    nonInteractive: (what) => `كانت هذه جولة داخلية تلقائية بلا إمكانية عرض تأكيد، لذلك رُفض ${what}.`,
    other: (what) => `رفض وضع الأذونات الحالي ${what}.`,
  },
};

function pick(table, locale) {
  const key = String(locale || "zh-CN");
  return table[key] || table[key.slice(0, 2)] || table["zh-CN"];
}

function describePermissionDenial({ toolName = "", mode = "", nonInteractive = false, locale = "zh-CN" } = {}) {
  const tools = pick(TOOLS, locale);
  const reasons = pick(REASONS, locale);
  const what = tools[String(toolName || "").toLowerCase()] || tools.generic;
  if (mode === "plan") return reasons.plan(what);
  if (nonInteractive) return reasons.nonInteractive(what);
  return reasons.other(what);
}

/** Ready-to-ingest runtime event for a refusal the user never saw. */
function permissionAutoDeniedNotice(input = {}) {
  let locale = input.locale;
  if (!locale) { try { locale = require("./locale-settings").getLocale() || "zh-CN"; } catch { locale = "zh-CN"; } }
  return { type: "engine.notice", payload: { notice: engineNotice("permissionAutoDenied", { replaces: "permissionAutoDenied", detail: describePermissionDenial({ ...input, locale }) }) } };
}

module.exports = { describePermissionDenial, permissionAutoDeniedNotice };
