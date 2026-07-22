"use strict";

const ERROR_PATTERNS = [
  {
    code: "RUNTIME_SKILL_PARSE_FAILED",
    category: "runtime_diagnostic",
    test: /Failed to parse skill .*SKILL\.md|skill failed to load|runtime skill parse error/i,
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
    test: /Session ID .* already in use|previous request is still completing/i,
    message: "The previous request is still completing. Please try again in a moment.",
    retryable: true,
  },
  {
    code: "RUNNER_TERMINATED",
    category: "session",
    // A concurrent terminate (idle recycling / session invalidation) raced the
    // engine start. The engine never launched, so the turn is side-effect-free
    // and safe to resend; the rescue path retries it silently with a fresh
    // runner. MUST precede MODEL_CONNECTION_FAILED — its broad "request failed"
    // catch previously relabeled this as a network interruption.
    test: /RUNNER_TERMINATED|runner was recycled|engine session was recycled/i,
    message: "The engine session was recycled before the reply could start. It restarts automatically on retry — please send your message again.",
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
    // Includes serve-startup failures (parse/port/early-exit) and the
    // control-plane HTTP timeout: a wedged serve is engine-unavailable, not a
    // model problem, and the rescue path recycles it.
    test: /command not found|ENOENT|assistant engine .*unreachable|engine .*unreachable|engine health check failed|engine wedged|wedged.*unreachable|did not report a listening port|exited before listening|opencode serve|session\.create failed|OPENCODE_HTTP_TIMEOUT|assistant engine is temporarily unavailable/i,
    message: "The assistant engine is temporarily unavailable. Please try again later.",
    retryable: true,
  },
  {
    code: "CONTEXT_LIMIT",
    category: "model",
    test: /context length|context window|maximum context|token limit|too many tokens|input too long|input length exceeds|maximum.*length|max.*tokens|request too large|payload too large|request entity too large|entity too large|body too large|content length.*exceed|413\b/i,
    message: "The request is too large for the assistant to process. Reduce large attachments, narrow the task, or start a new session, then retry.",
    retryable: false,
  },
  {
    code: "MANAGED_MODEL_AUTH_INVALID",
    category: "model",
    test: /MODEL_GATEWAY_TOKEN_(INVALID|EXPIRED)|Managed model access expired/i,
    message: "Managed model access expired. Lily refreshed the service configuration and retried.",
    retryable: true,
  },
  {
    code: "MANAGED_MODEL_AUTH_MISSING",
    category: "model",
    test: /ACCOUNT_LOGIN_REQUIRED|Managed model access is missing/i,
    message: "Managed model access is missing account or activation authorization. Lily refreshed the service configuration and retried.",
    retryable: true,
  },
  {
    code: "QUOTA_EXCEEDED",
    category: "model",
    // Gateway balance / entitlement rejections (HTTP 402/403-with-billing-
    // context). MUST be classified BEFORE AUTH_FAILED and
    // MODEL_CONNECTION_FAILED — a bare 403/"API Error:" would otherwise
    // relabel a quota exhaustion as an auth problem or a network drop, hiding
    // the real cause (out of balance) from the user. ACCOUNT_LOGIN_REQUIRED is
    // handled earlier (MANAGED_MODEL_AUTH_MISSING) so genuine login/activation
    // prompts still win over this.
    // NO BARE TOKENS: a bare `balance` matched "load balancer" in gateway 5xx
    // pages and told users to top up on an infra flake (a non-retryable label
    // on a retryable failure); bare `quota`/`billing`/`\b402\b` had the same
    // false-positive surface. Every alternative now requires billing context.
    // 402 is mechanically payment-required, so an error-context 402 alone
    // suffices; a 403 only counts WITH billing context (it can equally be
    // auth, region, or WAF).
    test: /ENTITLEMENT_INSUFFICIENT|payment.?required|(?:http|status|code|error)[^0-9a-z]{0,8}(?:402\b|403\b[^.]{0,120}(?:usage|quota|billing|balance|credit|limit))|insufficient.{0,24}(credit|balance|quota|fund)|(credit|balance|quota|fund)s?.{0,24}insufficient|usage limit|quota.{0,24}(exceed|exhaust|limit|refresh)|exceed.{0,24}(quota|usage)|out of (credits?|balance|funds?)|billing cycle|余额不足|已欠费|欠费|额度不足|配额不足|account.{0,16}(disabled|suspended)|billing.{0,24}(limit|issue|error|problem)/i,
    message: "Insufficient account balance or quota. Please top up your account, then retry.",
    retryable: false,
  },
  {
    code: "AUTH_FAILED",
    category: "model",
    // Only genuine credential failures land here — HTTP statuses and the words
    // "api key" alone prove nothing (a gateway 403 page can mean quota,
    // region, or WAF). Require explicit auth context so recoverable flakes
    // fall through to the retryable buckets below instead of telling the user
    // to check a key that is actually fine.
    test: /unauthorized|authentication failed|invalid (api[- ]?)?key|api[- ]?key (invalid|expired|revoked)|token (invalid|expired|revoked)|not authenticated|access denied|forbidden.{0,32}(key|token|auth)|(?:401|403).{0,48}(auth|key|token|unauthorized|forbidden)/i,
    message: "Authentication failed. Please check your API key in Settings, then retry.",
    retryable: false,
  },
  {
    code: "ATTACHMENT_UNSUPPORTED",
    category: "model",
    // The engine's AI SDK refused to BUILD the request because the conversation
    // carries a file part whose media type the active model/provider can't take
    // (e.g. a JSON/XML attachment on a model that only accepts image file parts).
    // This throws in getArgs BEFORE any HTTP call, so it never reaches the
    // gateway and no server-side sanitize can catch it — it must be classified
    // here. MUST precede MODEL_UNAVAILABLE/MODEL_CONNECTION_FAILED so their broad
    // "not supported"/"failed" catches don't relabel it as a dead model or a
    // network drop. Not retryable: the stored history still holds the file part,
    // so a blind resend fails the same way — the user must change the input.
    test: /AI_UnsupportedFunctionalityError|file part.{0,48}not supported|media type.{0,48}not supported|unsupported.{0,24}file part|attachment the selected model can't read/i,
    message: "This conversation includes an attachment the selected model can't read directly (for example a JSON or data file on an image-only model). The file is still available by its path — ask me to open it with file tools, switch to a model that accepts that file type, or start a new chat without the attachment.",
    retryable: false,
  },
  {
    code: "MODEL_UNAVAILABLE",
    category: "model",
    // The selected managed model is gone from the gateway — e.g. its provider
    // was removed server-side, so the gateway answers 404 "model provider not
    // configured". MUST precede MODEL_CONNECTION_FAILED so the broad "API Error:"
    // / 404 catch there does not relabel a removed model as a network drop.
    // Retryable: the session layer refreshes config on this, which drops the
    // dead preset and falls the active selection back to a delivered model.
    // "supported … model names|but you passed": a managed/proxy endpoint whose
    // backend was SWAPPED to a different model family rejects the configured
    // model name (field: OICM+ endpoint answering "The supported API model
    // names are deepseek-v4-pro …, but you passed Qwen/…"). Without this the
    // broad request-failed catch called it a network interruption.
    test: /model provider not configured|provider not configured|model provider not found|model gateway disabled|no model provider|selected model|pick a different model|model .*does not exist|model .*not found|model .*not supported|invalid model|may not have access to it|supported (?:API )?model names?|but you passed|\b404\b/i,
    message: "The selected model is no longer available. Configuration has been refreshed and the default model restored — please retry.",
    retryable: true,
  },
  {
    code: "MODEL_CONNECTION_FAILED",
    category: "model",
    test: /API Error:|Connection to the model service was interrupted|model service .*interrupted|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|timed? out|timeout|502|503|504|500\b|Internal Server Error|bad gateway|gateway time?out|upstream.*error|backend.*error|aborted|request.*failed|connection.*refused|connection.*reset|SSL|TLS|certificate|DNS|ENOTFOUND|ECONNABORTED/i,
    // Fact-only copy (2026-07-21 auto-repair): this is almost always an
    // upstream/transient flake the platform retries silently — never instruct
    // the user to check their network or settings.
    message: "The connection to the model service was interrupted. Lily retries automatically; if this persists, the model service is temporarily unavailable.",
    retryable: true,
  },
  {
    code: "BUDGET_EXCEEDED",
    category: "model",
    test: /maximum budget|budget exceeded|max budget|spend limit|budget limit/i,
    message: "This task has reached the budget limit and has been stopped. Please adjust the task scope or budget, then retry.",
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
    code: "PERMISSION_DENIED",
    category: "runtime",
    // Only errno-grade signals — bare "not permitted" prose (policy text,
    // upstream provider messages) is not a local permission failure. Retryable:
    // an engine recycle rebuilds sandbox/handle state, so the auto-repair path
    // gets its chance before this ever reaches the user.
    test: /permission denied|EACCES|EPERM|operation not permitted|system-level permission restriction/i,
    message: "A system-level permission restriction interrupted the engine. Lily retries automatically with a fresh engine session.",
    retryable: true,
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
  // Idempotency: an already-sanitized message passes through unchanged instead
  // of gaining a second "Request failed:" wrapper (and misclassifying via the
  // broad request-failed pattern on the next pass).
  if (/^request failed:/i.test(cleaned)) return cleaned;
  if (cleaned) {
    const detail = cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
    return `Request failed: ${detail}`;
  }
  return "An error occurred while processing the request. Please try again.";
}

function classifyAssistantError(raw) {
  // Strip our own wrapper so a re-sanitized message classifies by its payload,
  // not by the generic "Request failed:" prefix.
  const cleaned = scrubVendorNames(raw).replace(/^request failed:\s*/i, "");
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
