"use strict";

const ERROR_PATTERNS = [
  {
    code: "RUNTIME_SKILL_PARSE_FAILED",
    category: "runtime_diagnostic",
    test: /Failed to parse skill .*SKILL\.md/i,
    message: "A workspace skill failed to load. Lily ignored unrelated diagnostics, but this turn hit a runtime skill parse error. Please check the workspace skill file or disable that project skill.",
    retryable: false,
  },
  {
    code: "RUNTIME_PLUGIN_LOAD_FAILED",
    category: "runtime_diagnostic",
    test: /Failed to (load|parse) plugin|plugin .* failed/i,
    message: "A workspace runtime plugin failed to load. Please check the project plugin configuration or disable the plugin.",
    retryable: false,
  },
  {
    code: "SESSION_BUSY",
    category: "session",
    test: /Session ID .* already in use/i,
    message: "The previous request is still completing. Please try again in a moment.",
    retryable: true,
  },
  {
    code: "SESSION_INVALID",
    category: "session",
    test: /resume|session.*not found|unknown session|session context has expired/i,
    message: "Session context has expired (possibly due to restart). Recovery attempted — please send your message again.",
    retryable: true,
  },
  {
    code: "ENGINE_UNAVAILABLE",
    category: "runtime",
    test: /command not found|ENOENT|assistant engine .*unreachable|engine .*unreachable|engine health check failed|engine wedged|wedged.*unreachable/i,
    message: "The assistant engine is temporarily unavailable. Please try again later.",
    retryable: true,
  },
  {
    code: "MODEL_CONNECTION_FAILED",
    category: "model",
    test: /API Error:|Connection to the model service was interrupted|model service .*interrupted|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|timed? out|timeout|502|503|504|500\b|Internal Server Error|upstream.*error|backend.*error|aborted|request.*failed|connection.*refused|connection.*reset|SSL|TLS|certificate|DNS|ENOTFOUND|ECONNABORTED/i,
    message: "Connection to the model service was interrupted. Please check your network and API settings, then retry.",
    retryable: true,
  },
  {
    code: "BUDGET_EXCEEDED",
    category: "model",
    test: /maximum budget|budget exceeded|max budget|spend limit/i,
    message: "This task has reached the budget limit and has been stopped. Please adjust the task scope or budget, then retry.",
    retryable: false,
  },
  {
    code: "QUOTA_EXCEEDED",
    category: "model",
    test: /quota|insufficient.*credit|credit.*insufficient|balance|billing|account.*disabled|account.*suspended|payment.*required/i,
    message: "Insufficient model quota or billing issue. Please check your service quota, then retry.",
    retryable: false,
  },
  {
    code: "CONTEXT_LIMIT",
    category: "model",
    test: /context length|context window|maximum context|token limit|too many tokens|input too long|input length exceeds|maximum.*length|max.*tokens|request too large|payload too large/i,
    message: "The context is too large for the assistant to process. Please reduce the task scope or start a new session, then retry.",
    retryable: false,
  },
  {
    code: "RATE_LIMITED",
    category: "model",
    test: /rate.?limit|429|too many requests|too many.*request|throttled|slow down/i,
    message: "Too many requests. Please try again in a moment.",
    retryable: true,
  },
  {
    code: "MODEL_UNAVAILABLE",
    category: "model",
    test: /selected model|pick a different model|model .*does not exist|model .*not found|model .*not supported|invalid model|may not have access to it/i,
    message: "The selected model is currently unavailable. Configuration has been refreshed. Please try again later or switch to a different model.",
    retryable: true,
  },
  {
    code: "AUTH_FAILED",
    category: "model",
    test: /unauthorized|401|403|auth.*failed|auth.*invalid|auth.*expired|key.*invalid|key.*expired|token.*invalid|token.*expired|api.?key|invalid.*api|not authenticated|access denied|forbidden/i,
    message: "Authentication failed. Please check your API key in Settings, then retry.",
    retryable: false,
  },
  {
    code: "PERMISSION_DENIED",
    category: "runtime",
    test: /permission denied|EACCES|operation not permitted|not permitted/i,
    message: "Permission denied. Please check the session permissions or system permissions, then retry.",
    retryable: false,
  },
  {
    code: "MODEL_OVERLOADED",
    category: "model",
    test: /overloaded|too busy|service unavailable|maintenance|temporarily unavailable/i,
    message: "The model service is temporarily overloaded. Please wait a moment and retry.",
    retryable: true,
  },
  {
    code: "RESPONSE_ERROR",
    category: "model",
    test: /invalid.*response|empty.*response|unexpected.*response|JSON.*parse|parse.*error|malformed|bad.*response|no.*response|prompt accepted but no session activity|accepted .*message.*did not start|did not start the turn/i,
    message: "Received an unexpected response from the model service. Please retry.",
    retryable: true,
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
  const classified = classifyAssistantError(raw);
  if (classified) return classified.message;
  const cleaned = scrubVendorNames(String(raw || "").trim());
  if (cleaned) {
    const detail = cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
    return `Request failed: ${detail}`;
  }
  return "An error occurred while processing the request. Please try again.";
}

function classifyAssistantError(raw) {
  const cleaned = scrubVendorNames(raw);
  if (!cleaned.trim()) return null;
  for (const { code, category, test, message, retryable } of ERROR_PATTERNS) {
    if (test.test(cleaned)) {
      return {
        code,
        category,
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
