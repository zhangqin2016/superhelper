"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TRANSIENT_ERROR_RE = /unreachable|interrupted|socket|fetch|connection|network|ECONN|ETIMEDOUT|ENOTFOUND|timeout|temporarily unavailable|unexpected response/i;
const DOCUMENT_RECOVERY_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileFallbackLine(file = {}, index = 0) {
  const filePath = file.path || file.filePath || "";
  const name = file.name || (filePath ? path.basename(filePath) : `attachment-${index + 1}`);
  let stat = null;
  if (filePath) {
    try { stat = fs.statSync(filePath); } catch { stat = null; }
  }
  const size = Number.isFinite(Number(file.size))
    ? Number(file.size)
    : stat?.isFile?.()
      ? stat.size
      : null;
  return [
    `- ${name}`,
    filePath ? `  source path: ${filePath}` : "  source path: unavailable",
    file.type ? `  type: ${file.type}` : "",
    typeof file.isImage === "boolean" ? `  image: ${file.isImage ? "yes" : "no"}` : "",
    Number.isFinite(size) ? `  size: ${formatBytes(size)}` : "",
    filePath ? `  readable now: ${stat?.isFile?.() ? "yes" : "no"}` : "",
  ].filter(Boolean).join("\n");
}

function buildAttachmentFallbackManifest(files = [], reason = "") {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!list.length) return "";
  const shown = list.slice(0, 20).map((file, index) => fileFallbackLine(file, index));
  const omitted = list.length > shown.length
    ? `\n\n${list.length - shown.length} more attachment(s) omitted from this manifest.`
    : "";
  return [
    "[Attachment fallback manifest]",
    "The model file-upload request failed before the assistant could start. Continue the task inside Lily/CLI using these local source paths and available tools instead of failing the turn.",
    "Do not ask the user to re-upload unless a source path is missing or unreadable.",
    reason ? `Failure reason: ${reason}` : "",
    "",
    "Attached files:",
    shown.join("\n"),
    omitted,
  ].filter(Boolean).join("\n");
}

function buildAttachmentFallbackPromptPayload(payload = {}, reason = "") {
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length || payload.attachmentFallback) return payload;
  const manifest = buildAttachmentFallbackManifest(files, reason);
  if (!manifest) return payload;
  return {
    ...payload,
    text: [String(payload.text || ""), manifest].filter(Boolean).join("\n\n"),
    files: [],
    attachmentFallback: true,
  };
}

function isDocumentRecoveryAttachment(file = {}) {
  const filePath = file.path || file.filePath || "";
  const ext = path.extname(filePath).toLowerCase() || path.extname(file.name || file.filename || "").toLowerCase();
  if (DOCUMENT_RECOVERY_EXTENSIONS.has(ext)) return true;
  const type = String(file.type || file.mime || file.mimeType || file.mediaType || "").toLowerCase();
  return /pdf|document|officedocument|msword|word|spreadsheet|excel|powerpoint|presentation/.test(type);
}

function shouldIsolateAttachmentFallback(payload = {}) {
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files.some(isDocumentRecoveryAttachment);
}

function errorCauseFromEffect(effect = {}, message = "") {
  const raw = effect.cause || effect.error;
  if (raw instanceof Error) return raw;
  const error = new Error(message || "Engine error");
  if (raw && typeof raw === "object") {
    error.details = raw;
    if (raw.code) error.code = raw.code;
  }
  return error;
}

function failureCauseText(cause) {
  if (!cause) return "";
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message || "";
  if (typeof cause.message === "string") return cause.message;
  if (typeof cause.data?.message === "string") return cause.data.message;
  if (typeof cause.cause?.message === "string") return cause.cause.message;
  return "";
}

function transientClassificationText(message, cause) {
  return failureCauseText(cause) || String(message || "");
}

function isRecoverableModelConnectionFailure(classified, raw = "") {
  if (classified?.retryable === false) return false;
  if (classified && [
    "MODEL_CONNECTION_FAILED",
    "ENGINE_UNAVAILABLE",
    "MODEL_OVERLOADED",
    "RESPONSE_ERROR",
    "RATE_LIMITED",
    "MANAGED_MODEL_AUTH_INVALID",
    "MANAGED_MODEL_AUTH_MISSING",
  ].includes(classified.code)) return true;
  return !classified && TRANSIENT_ERROR_RE.test(String(raw || ""));
}

function isManagedGatewayAuthFailure(classified, raw = "", spawnOptions = null) {
  const text = String(raw || "");
  if (classified?.code === "MANAGED_MODEL_AUTH_INVALID" || classified?.code === "MANAGED_MODEL_AUTH_MISSING") return true;
  if (/MODEL_GATEWAY_TOKEN_(INVALID|EXPIRED)/i.test(text)) return true;
  const audit = spawnOptions?.modelRouteAudit || {};
  return audit.keyKind === "gateway-token"
    && audit.route === "gateway"
    && /unauthorized|401|403|auth|token|api.?key/i.test(text);
}

function isOversizedContextFailure(classified, raw = "") {
  return classified?.code === "CONTEXT_LIMIT"
    || /request entity too large|request too large|payload too large|body too large|413\b/i.test(String(raw || ""));
}

function isManagedGatewayModelUnavailable(classified, raw = "", spawnOptions = null) {
  const text = String(raw || "");
  if (/model provider not configured|provider not configured|model provider not found|model gateway disabled/i.test(text)) return true;
  const audit = spawnOptions?.modelRouteAudit || {};
  const gatewayRoute = audit.route === "gateway" || audit.keyKind === "gateway-token";
  return classified?.code === "MODEL_UNAVAILABLE" && gatewayRoute;
}

function isManagedModelConfigStale(classified, raw = "", spawnOptions = null) {
  return isManagedGatewayAuthFailure(classified, raw, spawnOptions)
    || isManagedGatewayModelUnavailable(classified, raw, spawnOptions);
}

function isSafeReplayableModelFailure(classified, raw = "", spawnOptions = null) {
  return isManagedGatewayAuthFailure(classified, raw, spawnOptions)
    || isManagedGatewayModelUnavailable(classified, raw, spawnOptions)
    || isRecoverableModelConnectionFailure(classified, raw)
    || isOversizedContextFailure(classified, raw);
}

function shouldDropResumeAfterVisibleFailure({ classified, raw = "", payload = {}, wasResumed = false } = {}) {
  if (classified?.code === "SESSION_INVALID") return true;
  if (isOversizedContextFailure(classified, raw)) return true;
  if (!isRecoverableModelConnectionFailure(classified, raw) && !isManagedGatewayAuthFailure(classified, raw)) return false;
  if (wasResumed) return true;
  if (payload?.attachmentFallback) return true;
  return shouldIsolateAttachmentFallback(payload);
}

module.exports = {
  buildAttachmentFallbackManifest,
  buildAttachmentFallbackPromptPayload,
  errorCauseFromEffect,
  failureCauseText,
  isManagedGatewayAuthFailure,
  isManagedGatewayModelUnavailable,
  isManagedModelConfigStale,
  isOversizedContextFailure,
  isRecoverableModelConnectionFailure,
  isSafeReplayableModelFailure,
  shouldDropResumeAfterVisibleFailure,
  shouldIsolateAttachmentFallback,
  transientClassificationText,
};
