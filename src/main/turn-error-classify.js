"use strict";

/**
 * Pure turn-failure classification + failure-text extraction, factored out of
 * turn-orchestrator so it can be unit-tested in isolation (no electron, no
 * orchestrator state machine). Depends only on agent-runner's pure string
 * helpers. The orchestrator uses: classifyTurnFailure, isRecoverableFailure,
 * preflightFailureText, collectFailureTextFromState.
 */

const { sanitizeError, classifyAssistantError, scrubVendorNames } = require("./agent-runner");

/** User-facing message when pre-send (vision/document) processing fails. */
function preflightFailureText(error, detail) {
  const suffix = detail ? `\n\n${String(detail).trim()}` : "";
  switch (error) {
    case "VISION_UNAVAILABLE":
      return `Image recognition service is temporarily unavailable. The image could not be processed. Please try again later, or add a text description and resend.${suffix}`;
    case "VISION_FAILED":
      return `Image parsing failed and was not forwarded to the assistant. Please try again later, or add a text description and resend.${suffix}`;
    case "DOCUMENT_FAILED":
      return `Document parsing failed and was not forwarded to the assistant. Please check if the file can be opened, or add a text description and resend.${suffix}`;
    default:
      return `Pre-send processing failed and was not forwarded to the assistant. Please try again later.${suffix}`;
  }
}

/** Transient/network-ish failures worth one automatic recovery attempt. */
function isRecoverableFailure(raw) {
  return /API Error:|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|502|503|504|rate.?limit|429/i.test(String(raw || ""));
}

function compactFailureDetail(raw) {
  const text = scrubVendorNames(raw).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 260 ? `${text.slice(0, 260)}…` : text;
}

function failureTextFromProcessEvent(event = {}) {
  const rawSubtype = String(event.rawSubtype || event.event?.subtype || "");
  const rawType = String(event.rawType || event.event?.type || "");
  const values = [];
  const raw = event.event || {};
  if (typeof raw.error === "string") values.push(raw.error);
  if (Array.isArray(raw.errors)) values.push(raw.errors.join("\n"));
  if (typeof raw.message === "string" && (rawType === "error" || rawSubtype.startsWith("error"))) {
    values.push(raw.message);
  }
  if (rawSubtype.startsWith("error")) values.push(rawSubtype);
  for (const action of event.actions || []) {
    if (typeof action?.notice?.detail === "string") values.push(action.notice.detail);
    if (typeof action?.notice?.message === "string") values.push(action.notice.message);
  }
  return values.filter(Boolean).join("\n");
}

function failureTextFromNoticeEvent(event = {}) {
  const notice = event.payload?.notice || event.notice || event.payload || event;
  if (!notice || typeof notice !== "object") return "";
  const level = String(notice.level || "");
  const code = String(notice.code || "");
  if (level !== "warning" && !/error|fail|denied|timeout/i.test(code)) return "";
  return [notice.detail, notice.message, code].filter((value) => typeof value === "string" && value.trim()).join("\n");
}

/** Most recent failure-bearing text from the turn's process events + notices. */
function collectFailureTextFromState(state = {}) {
  const parts = [];
  for (const event of [...(state.processEvents || [])].reverse()) {
    const text = failureTextFromProcessEvent(event);
    if (text) {
      parts.push(text);
      break;
    }
  }
  for (const event of [...(state.notices || [])].reverse()) {
    const text = failureTextFromNoticeEvent(event);
    if (text) {
      parts.push(text);
      break;
    }
  }
  return parts.join("\n");
}

/**
 * Classify a turn failure into { code, message, retryable } or null when the
 * turn did not fail.
 */
function classifyTurnFailure(payload, normalized, state) {
  const rawError = [
    payload?.error,
    payload?.errorText,
    payload?.message,
    payload?.resultSubtype,
    collectFailureTextFromState(state),
  ].filter((value) => typeof value === "string" && value.trim()).join("\n");
  const errorClassified = classifyAssistantError(rawError);
  if (errorClassified) return errorClassified;
  if (normalized?.failed) {
    return {
      code: normalized.errorCode || "ASSISTANT_ERROR",
      message: normalized.text || sanitizeError(collectFailureTextFromState(state)) || "The assistant engine encountered an error. Please retry.",
      retryable: normalized.retryable !== false,
    };
  }
  if (payload?.engineInterrupted) {
    return {
      code: "ENGINE_INTERRUPTED",
      message: "The assistant engine interrupted this response. Please retry.",
      retryable: true,
    };
  }
  if (payload?.code && payload.code !== 0) {
    return {
      code: payload?.source === "process.close" ? "ENGINE_PROCESS_EXITED" : "ENGINE_RESULT_FAILED",
      message: rawError
        ? `Assistant engine returned failure: ${compactFailureDetail(rawError)}`
        : "Assistant process exited unexpectedly. Please retry. If this persists, restart the application.",
      retryable: true,
    };
  }
  return null;
}

module.exports = {
  preflightFailureText,
  isRecoverableFailure,
  collectFailureTextFromState,
  classifyTurnFailure,
  // exported for focused testing
  compactFailureDetail,
  failureTextFromProcessEvent,
  failureTextFromNoticeEvent,
};
