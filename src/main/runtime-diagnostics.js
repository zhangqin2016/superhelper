"use strict";

const crypto = require("node:crypto");
const { getLogger } = require("./logger");
const log = getLogger("runtime-diagnostics");

const UPLOAD_DEBOUNCE_MS = 30_000;
const recentUploads = new Map();

function safeString(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function hashValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function sanitizeEvent(event = {}) {
  return {
    type: safeString(event.type),
    subtype: safeString(event.subtype || event.request?.subtype || event.event?.type),
    requestSubtype: safeString(event.request?.subtype),
    toolName: safeString(event.request?.tool_name || event.request?.toolName || event.tool_name),
    keys: event && typeof event === "object" ? Object.keys(event).slice(0, 30) : [],
    requestKeys:
      event.request && typeof event.request === "object"
        ? Object.keys(event.request).slice(0, 30)
        : [],
    eventKeys:
      event.event && typeof event.event === "object"
        ? Object.keys(event.event).slice(0, 30)
        : [],
  };
}

function diagnosticKey(payload) {
  return [
    payload?.normalizedKind || "",
    payload?.eventType || "",
    payload?.eventSubtype || "",
    payload?.summary || "",
  ].join("|");
}

async function reportRuntimeProtocolIssue(payload = {}) {
  const normalizedKind = safeString(payload.normalizedKind || payload.kind || "unknown_runtime_event");
  const event = payload.event || {};
  const eventType = safeString(payload.eventType || event.type);
  const eventSubtype = safeString(
    payload.eventSubtype || event.subtype || event.request?.subtype || event.event?.type,
  );
  const summary = safeString(
    payload.summary ||
      `${normalizedKind}${eventType ? ` ${eventType}` : ""}${eventSubtype ? `/${eventSubtype}` : ""}`,
    500,
  );

  const diagnostic = {
    claudeVersion: safeString(payload.claudeVersion),
    eventType,
    eventSubtype,
    normalizedKind,
    severity: payload.severity === "error" ? "error" : payload.severity === "info" ? "info" : "warning",
    turnPhase: safeString(payload.turnPhase, 80),
    sessionState: safeString(payload.sessionState, 80),
    summary,
    trace: {
      schemaVersion: 1,
      event: sanitizeEvent(event),
      eventHash: hashValue(JSON.stringify(sanitizeEvent(event))),
      notice: payload.notice
        ? {
            code: safeString(payload.notice.code),
            level: safeString(payload.notice.level),
            type: safeString(payload.notice.type),
            subtype: safeString(payload.notice.subtype),
          }
        : null,
    },
  };

  const key = diagnosticKey(diagnostic);
  const now = Date.now();
  const last = recentUploads.get(key) || 0;
  if (now - last < UPLOAD_DEBOUNCE_MS) return { ok: true, skipped: true };
  recentUploads.set(key, now);

  try {
    return await require("./service-client").reportRuntimeDiagnostic(diagnostic);
  } catch (error) {
    log.warn("runtime diagnostic upload failed: %s", error?.message || String(error));
    return { ok: false, error: "UPLOAD_FAILED" };
  }
}

module.exports = {
  reportRuntimeProtocolIssue,
  sanitizeEvent,
};
