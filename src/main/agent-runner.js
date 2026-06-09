"use strict";

const ERROR_PATTERNS = [
  {
    code: "SESSION_BUSY",
    test: /Session ID .* already in use/i,
    message: "The previous request is still completing. Please try again in a moment.",
    retryable: true,
  },
  {
    code: "SESSION_INVALID",
    test: /resume|session.*not found|unknown session/i,
    message: "Session context has expired (possibly due to restart). Recovery attempted — please send your message again.",
    retryable: true,
  },
  {
    code: "ENGINE_UNAVAILABLE",
    test: /command not found|ENOENT/i,
    message: "The assistant engine is temporarily unavailable. Please try again later.",
    retryable: true,
  },
  {
    code: "MODEL_CONNECTION_FAILED",
    test: /API Error:|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|timed? out|timeout|502|503|504/i,
    message: "Connection to the model service was interrupted. Please check your network and API settings, then retry.",
    retryable: true,
  },
  {
    code: "BUDGET_EXCEEDED",
    test: /maximum budget|budget exceeded|max budget|spend limit/i,
    message: "This task has reached the budget limit and has been stopped. Please adjust the task scope or budget, then retry.",
    retryable: false,
  },
  {
    code: "QUOTA_EXCEEDED",
    test: /quota|insufficient.*credit|credit.*insufficient|balance|billing/i,
    message: "Insufficient model quota or billing issue. Please check your service quota, then retry.",
    retryable: false,
  },
  {
    code: "CONTEXT_LIMIT",
    test: /context length|context window|maximum context|token limit|too many tokens|input too long/i,
    message: "The context is too large for the assistant to process. Please reduce the task scope or start a new session, then retry.",
    retryable: false,
  },
  {
    code: "RATE_LIMITED",
    test: /rate.?limit|429|too many requests/i,
    message: "Too many requests. Please try again in a moment.",
    retryable: true,
  },
  {
    code: "MODEL_UNAVAILABLE",
    test: /selected model|pick a different model|model .*does not exist|model .*not found|model .*not supported|invalid model|may not have access to it/i,
    message: "The selected model is currently unavailable. Configuration has been refreshed. Please try again later or switch to a different model.",
    retryable: true,
  },
  {
    code: "PERMISSION_DENIED",
    test: /permission denied|EACCES|operation not permitted|not permitted/i,
    message: "Permission denied. Please check the session permissions or system permissions, then retry.",
    retryable: false,
  },
];

function isUpstreamApiFailure(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  return ERROR_PATTERNS.some(({ test }) => test.test(text));
}

function scrubVendorNames(raw) {
  return String(raw || "")
    .replace(/\bclaude\b/gi, "assistant")
    .replace(/\banthropic\b/gi, "service");
}

function sanitizeError(raw) {
  return classifyAssistantError(raw)?.message || "An error occurred while processing the request. Please try again.";
}

function classifyAssistantError(raw) {
  const cleaned = scrubVendorNames(raw);
  if (!cleaned.trim()) return null;
  for (const { code, test, message, retryable } of ERROR_PATTERNS) {
    if (test.test(cleaned)) {
      return {
        code,
        message,
        retryable: retryable !== false,
      };
    }
  }
  return null;
}

/** @returns {{ text: string, failed: boolean, errorCode?: string, retryable?: boolean }} */
function normalizeAssistantOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) return { text: "", failed: false };
  const classified = classifyAssistantError(text);
  if (classified) {
    return {
      text: classified.message,
      failed: true,
      errorCode: classified.code,
      retryable: classified.retryable,
    };
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
  classifyAssistantError,
  isUpstreamApiFailure,
  normalizeAssistantOutput,
};
