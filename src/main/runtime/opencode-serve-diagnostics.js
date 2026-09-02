"use strict";

/**
 * Make the engine's silent retries visible.
 *
 * `opencode serve` logs its own failures to stderr as logfmt, e.g.
 *
 *   timestamp=… level=ERROR message="stream error" providerID=lily-model-…
 *   modelID=deepseek-v4-pro session.id=ses_… agent=build mode=primary
 *   error.error="AI_APICallError: Server Overloaded"
 *
 * The host only ever wrote that to its log file, so when a provider was
 * overloaded the engine retried on a 4s/7s backoff while the user watched an
 * unexplained "思考中" — the single most common reason Lily feels less smooth
 * than a CLI that prints "retrying (attempt 2)…". The failure IS already
 * classified elsewhere (agent-runner's overload family), but only once it
 * becomes a terminal turn failure; retries that eventually succeed told the
 * user nothing.
 *
 * This module is pure parsing + classification; delivery rides a dedicated
 * `diagnostic` channel on the shared server (a diagnostic is not turn content,
 * so it must not travel with turn events). A line we cannot parse — or one with
 * no session id — yields null and therefore nothing, which is exactly today's
 * behaviour.
 */

// Transient upstream trouble worth telling the user about: the provider is busy
// or the hop failed, and the engine will retry. Deliberately NARROW — a genuine
// config error (bad key, unknown model, unsupported tool call) is not a retry
// and must keep flowing to the normal terminal-failure classification instead of
// being softened into "just retrying".
const TRANSIENT_ERROR_RE = new RegExp([
  "overload", "too busy", "rate.?limit", "quota",
  "service unavailable", "temporarily unavailable", "maintenance",
  "timeout", "timed out", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED",
  "EAI_AGAIN", "socket hang", "fetch failed", "network",
  "\\b429\\b", "\\b50[0234]\\b", "\\b529\\b",
].join("|"), "i");

const LOGFMT_PAIR_RE = /([A-Za-z][\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;

function parseLogfmt(line) {
  const out = {};
  for (const match of String(line).matchAll(LOGFMT_PAIR_RE)) {
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3];
    out[match[1]] = value;
  }
  return out;
}

/**
 * Parse ONE serve stderr line into a session-scoped retry diagnostic, or null
 * when it is not one (different message, non-transient error, no session id,
 * truncated chunk). Null means "log it and say nothing", i.e. today.
 */
function parseServeDiagnostic(line) {
  const text = String(line || "").trim();
  if (!text || !text.includes("=")) return null;
  const fields = parseLogfmt(text);
  if (String(fields.level || "").toUpperCase() !== "ERROR") return null;
  const sessionID = String(fields["session.id"] || fields.sessionID || "").trim();
  if (!sessionID.startsWith("ses_")) return null;
  const error = String(fields["error.error"] || fields.error || "").trim();
  const message = String(fields.message || "").trim();
  if (!TRANSIENT_ERROR_RE.test(error)) return null;
  return {
    sessionID,
    message,
    error,
    providerID: String(fields.providerID || "").trim(),
    modelID: String(fields.modelID || "").trim(),
    agent: String(fields.agent || "").trim(),
  };
}

/** Parse a whole stderr chunk (may hold several lines). */
function parseServeDiagnostics(chunk) {
  return String(chunk || "")
    .split(/\r?\n/)
    .map((line) => parseServeDiagnostic(line))
    .filter(Boolean);
}

/**
 * Should THIS session be told about the serve's diagnostic? A shared serve hosts
 * many sessions, so an exact session-id match is required: showing one session's
 * retry inside another would be worse than staying quiet. Single source of truth
 * for the routing decision — ServerManager and its guard test both use it.
 */
function diagnosticBelongsToSession(info, sessionID) {
  const target = String(info?.sessionID || "");
  const own = String(sessionID || "");
  return Boolean(target && own && target === own);
}

/** Strip the SDK's error-class prefix: "AI_APICallError: Server Overloaded". */
function shortErrorText(error) {
  const text = String(error || "").replace(/^[A-Za-z_]*Error:\s*/, "").trim();
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * User-facing progress detail. Names WHO is failing (the model service, not
 * Lily), WHAT it said, and that a retry is in flight with its attempt count —
 * the three things the silent version withheld.
 */
function buildRetryNoticeDetail(info = {}, attempt = 1) {
  const reason = shortErrorText(info.error);
  const model = String(info.modelID || "").trim();
  const parts = [model ? `模型服务（${model}）暂时不可用` : "模型服务暂时不可用"];
  if (reason) parts.push(reason);
  parts.push(attempt > 1 ? `正在重试 · 第 ${attempt} 次` : "正在重试");
  return parts.join(" · ");
}

module.exports = {
  buildRetryNoticeDetail,
  diagnosticBelongsToSession,
  parseServeDiagnostic,
  parseServeDiagnostics,
  shortErrorText,
};
