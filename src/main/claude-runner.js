"use strict";

const ERROR_PATTERNS = [
  {
    test: /Session ID .* already in use/i,
    message: "刚才的请求还在收尾，请稍后再试。",
  },
  {
    test: /command not found|ENOENT/i,
    message: "助手暂时无法连接，请稍后再试。",
  },
];

function sanitizeError(raw) {
  for (const { test, message } of ERROR_PATTERNS) {
    if (test.test(raw)) return message;
  }
  return "处理请求时遇到问题，请稍后再试。";
}

function appendTextSegment(prev, next) {
  const piece = String(next ?? "");
  if (!piece) return prev || "";
  const base = prev || "";
  if (!base) return piece;
  if (base.endsWith("\n") || piece.startsWith("\n")) return base + piece;
  return `${base}\n\n${piece}`;
}

module.exports = { sanitizeError, appendTextSegment };
