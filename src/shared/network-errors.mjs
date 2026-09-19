/**
 * What a transient network failure looks like — the ONE list.
 *
 * Six modules each kept their own list of socket/DNS/timeout error codes and
 * phrases (retry policy for downloads, the model probe, serve diagnostics, the
 * failure classifier, the session failure policy, collaboration offline
 * detection). A new code from the fetch stack (undici's UND_ERR_* family) had
 * to be added in six places to be retried everywhere, and was not.
 *
 * Each site composes its OWN scope on top of this base — the probe also
 * treats HTTP 5xx as transient, serve diagnostics also watch for "overload" —
 * but the transport-level signature is spelled once here.
 */

/** Node / undici error codes that mean "the wire failed", not "you were refused". */
export const TRANSIENT_NETWORK_CODES = Object.freeze([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

/** Phrases the same failures carry when only a message survives. */
export const TRANSIENT_NETWORK_PHRASES = Object.freeze([
  "fetch failed", "socket hang up", "socket connection was closed", "timed out", "network error", "connection reset", "connection refused",
]);

const CODE_SET = new Set(TRANSIENT_NETWORK_CODES);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regex source fragment (no flags) for composing a site's own classifier. */
export const TRANSIENT_NETWORK_SIGNATURE = [...TRANSIENT_NETWORK_CODES, ...TRANSIENT_NETWORK_PHRASES].map(escape).join("|");
export const TRANSIENT_NETWORK_RE = new RegExp(TRANSIENT_NETWORK_SIGNATURE, "i");

export function isTransientNetworkCode(code) {
  return CODE_SET.has(String(code || "").trim().toUpperCase());
}

/** Does an error (or its cause) or a message carry the transient signature? */
export function isTransientNetworkError(error) {
  if (!error) return false;
  if (typeof error === "string") return TRANSIENT_NETWORK_RE.test(error);
  if (error.name === "AbortError") return true;
  if (isTransientNetworkCode(error.cause?.code) || isTransientNetworkCode(error.code)) return true;
  return TRANSIENT_NETWORK_RE.test(String(error.message || ""));
}
