"use strict";

/**
 * The shape of a failed turn — built in one place.
 *
 * Fourteen sites built the `turn.failed` payload by hand and disagreed about
 * it: `code` at seven, `errorCode` at ten, both at three, `failed: true`
 * missing at one, `retryable` sometimes absent. Five readers each carried
 * their own `payload.errorCode || payload.code` to cope. And `code` is also
 * the name of a process EXIT code on runner payloads, so the fallback could
 * turn an exit status into an error code. One builder, one field name
 * (`errorCode`), one reader for records written before this.
 */

const DEFAULT_CODE = "TURN_FAILED";

/**
 * @param {{ code?: string, assistant?: string, category?: string, retryable?: boolean, error?: string, [extra: string]: unknown }} input
 *   code       the platform's failure code (RUNNER_ERROR, RESUME_INVALID, …)
 *   assistant  what the user is shown for this turn ("" when nothing should be)
 *   category   session | runtime | environment | durability | … ("" when unknown)
 *   retryable  whether a resend can succeed (default true)
 *   error      the raw engine/provider message, when there is one
 *   extra      anything the site knows (source, exitCode, recoveryId, terminalAlreadyRecorded, …)
 */
function turnFailure(input = {}) {
  const { code, errorCode, assistant = "", category, errorCategory, retryable, error, ...extra } = input;
  const failure = {
    failed: true,
    assistant: typeof assistant === "string" ? assistant : String(assistant ?? ""),
    errorCode: String(code || errorCode || "").trim() || DEFAULT_CODE,
    errorCategory: String(category || errorCategory || ""),
    retryable: retryable !== false,
  };
  if (typeof error === "string" && error) failure.error = error;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) failure[key] = value;
  return failure;
}

/**
 * The failure code of a payload or a stored record, whatever it was written
 * with — the ONE place that still understands the legacy field names.
 */
function failureCodeOf(payload = null) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of ["errorCode", "failureCode", "code"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

module.exports = { DEFAULT_FAILURE_CODE: DEFAULT_CODE, failureCodeOf, turnFailure };
