"use strict";

const ERROR_PATTERNS = [
  {
    test: /Session ID .* already in use/i,
    message: "刚才的请求还在收尾，请稍后再试。",
  },
  {
    test: /resume|session.*not found|unknown session/i,
    message: "对话上下文已失效（可能因重启中断）。已尝试恢复，请再发一次消息。",
  },
  {
    test: /command not found|ENOENT/i,
    message: "助手暂时无法连接，请稍后再试。",
  },
  {
    test: /API Error:|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|502|503|504/i,
    message: "与模型服务的连接中断，请检查网络与 API 配置后重试。",
  },
  {
    test: /rate.?limit|429|too many requests/i,
    message: "请求过于频繁，请稍后再试。",
  },
  {
    test: /selected model|pick a different model|model .*does not exist|model .*not found|model .*not supported|invalid model|may not have access to it/i,
    message: "当前模型暂时不可用，已刷新配置。请稍后重试或切换模型。",
  },
];

function isUpstreamApiFailure(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  return ERROR_PATTERNS.some(({ test }) => test.test(text));
}

function scrubVendorNames(raw) {
  return String(raw || "")
    .replace(/\bclaude\b/gi, "助手")
    .replace(/\banthropic\b/gi, "服务");
}

function sanitizeError(raw) {
  const cleaned = scrubVendorNames(raw);
  for (const { test, message } of ERROR_PATTERNS) {
    if (test.test(cleaned)) return message;
  }
  return "处理请求时遇到问题，请稍后再试。";
}

/** @returns {{ text: string, failed: boolean }} */
function normalizeAssistantOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) return { text: "", failed: false };
  if (isUpstreamApiFailure(text)) {
    return { text: sanitizeError(text), failed: true };
  }
  return { text, failed: false };
}

function appendTextSegment(prev, next) {
  const piece = String(next ?? "");
  if (!piece) return prev || "";
  const base = prev || "";
  if (!base) return piece;
  if (base.endsWith("\n") || piece.startsWith("\n")) return base + piece;
  return `${base}\n\n${piece}`;
}

module.exports = {
  sanitizeError,
  appendTextSegment,
  scrubVendorNames,
  isUpstreamApiFailure,
  normalizeAssistantOutput,
};
