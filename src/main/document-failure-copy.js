"use strict";

/**
 * Plain-language reason a document could not be read.
 *
 * Until 2026-09-15 every failure surfaced as the same bare "已跳过文档解析"
 * chip, so a missing runtime, an old .doc, a password-protected file and a
 * timeout were indistinguishable — which is what made attaching a Word file
 * feel random. The extractor's own reason is now carried out to the notice.
 */

const COPY = {
  "zh-CN": {
    RUNTIME_UNAVAILABLE: "文档解析组件未就绪（运行时未安装或损坏），可在设置里修复后重试。",
    EXTRACTOR_MISSING: "文档解析脚本缺失，重新安装或修复运行时后可恢复。",
    LEGACY_FORMAT: (ext) => `不支持旧版 ${ext} 格式，请在 Word 里另存为 .docx 后再试。`,
    EXTRACT_TIMEOUT: "文档解析超时，文件可能过大或结构复杂。",
    EXTRACT_BAD_OUTPUT: "文档解析返回了无法识别的结果。",
    UNREADABLE: "无法读取文件内容，可能已加密、损坏或已被移动。",
    detail: (reason) => `原因：${reason}`,
    fallback: "文档解析失败。",
  },
  en: {
    RUNTIME_UNAVAILABLE: "The document reader runtime is not ready (missing or damaged); repair it in settings and retry.",
    EXTRACTOR_MISSING: "The document extraction script is missing; reinstalling or repairing the runtime restores it.",
    LEGACY_FORMAT: (ext) => `The legacy ${ext} format is not supported. Save it as .docx in Word and try again.`,
    EXTRACT_TIMEOUT: "Reading the document timed out; it may be very large or unusually structured.",
    EXTRACT_BAD_OUTPUT: "The document reader returned an unreadable result.",
    UNREADABLE: "The file could not be read; it may be encrypted, damaged, or moved.",
    detail: (reason) => `Reason: ${reason}`,
    fallback: "The document could not be read.",
  },
  ar: {
    RUNTIME_UNAVAILABLE: "مكوّن قراءة المستندات غير جاهز (مفقود أو تالف)؛ أصلحه من الإعدادات وأعد المحاولة.",
    EXTRACTOR_MISSING: "برنامج استخراج المستندات مفقود؛ إعادة تثبيت البيئة أو إصلاحها يعيده.",
    LEGACY_FORMAT: (ext) => `صيغة ${ext} القديمة غير مدعومة. احفظ الملف بصيغة .docx ثم أعد المحاولة.`,
    EXTRACT_TIMEOUT: "انتهت مهلة قراءة المستند؛ قد يكون كبيرا جدا أو معقّد البنية.",
    EXTRACT_BAD_OUTPUT: "أعاد قارئ المستندات نتيجة غير مفهومة.",
    UNREADABLE: "تعذّرت قراءة الملف؛ قد يكون مشفّرا أو تالفا أو تم نقله.",
    detail: (reason) => `السبب: ${reason}`,
    fallback: "تعذّرت قراءة المستند.",
  },
};

function copyFor(locale) {
  const key = String(locale || "zh-CN");
  return COPY[key] || COPY[key.slice(0, 2)] || COPY["zh-CN"];
}

/** @param {string} error e.g. "LEGACY_FORMAT:.doc", "EXTRACT_FAILED:password protected" */
function describeDocumentFailure(error, locale = "zh-CN") {
  const copy = copyFor(locale);
  const raw = String(error || "").trim();
  const [code, ...rest] = raw.split(":");
  const tail = rest.join(":").trim();
  if (code === "LEGACY_FORMAT") return copy.LEGACY_FORMAT(tail || ".doc");
  if (code === "EXTRACT_TIMEOUT") return copy.EXTRACT_TIMEOUT;
  if (typeof copy[code] === "string") return copy[code];
  if (code === "EXTRACT_FAILED" && tail) return `${copy.UNREADABLE}${copy.detail(tail.slice(0, 160))}`;
  return raw ? `${copy.fallback}${copy.detail(raw.slice(0, 160))}` : copy.fallback;
}

/** One line for the notice chip: at most two distinct reasons. */
function describeDocumentFailures(failures = [], locale = "zh-CN") {
  const reasons = [];
  for (const item of Array.isArray(failures) ? failures : []) {
    const text = describeDocumentFailure(item?.error, locale);
    if (text && !reasons.includes(text)) reasons.push(text);
    if (reasons.length >= 2) break;
  }
  return reasons.join(" ");
}

module.exports = { describeDocumentFailure, describeDocumentFailures };
