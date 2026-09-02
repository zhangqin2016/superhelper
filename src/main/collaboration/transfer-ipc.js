"use strict";

const commands = Object.freeze({
  "get-transfers": ["getTransfers", []],
  "prepare-attachment": ["prepareAttachment", ["conversationId"]],
  "enqueue-transfer": ["enqueueTransfer", ["transferId"]],
  "pause-transfer": ["pauseTransfer", ["transferId"]],
  "cancel-transfer": ["cancelTransfer", ["transferId"]],
  "prepare-download": ["prepareDownload", ["conversationId", "messageId", "objectId"]],
  "save-download": ["saveDownload", ["transferId"]],
  "resolve-preview": ["previewDownload", ["transferId"]],
  "send-attachments": ["sendAttachments", ["conversationId", "transferIds", "bodyText", "clientCommandId"]],
});
const methods = new Set(Object.values(commands).map(([method]) => method));
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const number = (value) => Number.isSafeInteger(value) && value >= 0;
const code = (value) => typeof value === "string" && value.length <= 100 && /^(COLLAB[A-Z_]*|LILYENC_[A-Z_]+)$/.test(value);

function transferView(value = {}) {
  const result = { ok: value.ok === true };
  for (const key of ["id", "conversationId", "objectId", "clientCommandId"]) if (identifier(value[key])) result[key] = value[key];
  for (const key of ["totalBytes", "completedParts", "attempts", "nextAttemptAt", "bytes"]) if (number(value[key])) result[key] = value[key];
  if (typeof value.scopeId === "string" && value.scopeId.length <= 210 && /^(personal|team:[A-Za-z0-9_-]+)$/.test(value.scopeId)) result.scopeId = value.scopeId;
  if (["upload", "download"].includes(value.direction)) result.direction = value.direction;
  if (["attachment", "workspace"].includes(value.purpose)) result.purpose = value.purpose;
  if (["waiting_attachments", "queued", "prepared", "encrypting", "uploading", "uploaded", "verifying", "verified", "bound", "downloading", "decrypting", "ready", "paused", "failed", "cancelled", "submitting", "confirming", "persisted", "delivery_unknown"].includes(value.state)) result.state = value.state;
  if (["waiting_attachments", "ready_to_handoff", "queued", "submitting", "confirming", "persisted", "cancelled", "delivery_unknown", "paused", "failed", "cancellation_requested"].includes(value.sendState)) result.sendState = value.sendState;
  if (typeof value.originalName === "string" && value.originalName.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(value.originalName)) result.originalName = value.originalName;
  for (const key of ["automaticRetry", "serverCancelled", "retryable", "cancelled", "saved"]) if (typeof value[key] === "boolean") result[key] = value[key];
  if (code(value.code)) result.code = value.code;
  return result;
}

function transferResult(method, value, { toPreviewUrl } = {}) {
  if (!methods.has(method)) return null;
  if (method === "getTransfers" && value?.ok === true) return { ok: true, transfers: (Array.isArray(value.transfers) ? value.transfers : []).map((transfer) => transferView({ ok: true, ...transfer })),
    unrecognizedCount: number(value.unrecognizedCount) ? value.unrecognizedCount : 0,
    recoveryFailureCount: number(value.recoveryFailureCount) ? value.recoveryFailureCount : 0 };
  if (method === "previewDownload" && value?.ok === true && typeof value.path === "string") {
    const url = typeof toPreviewUrl === "function" ? toPreviewUrl(value.path) : "";
    const result = { ok: true };
    if (typeof value.mimeType === "string" && value.mimeType.length <= 100) result.mimeType = value.mimeType;
    if (typeof value.originalName === "string" && value.originalName.length <= 255) result.originalName = value.originalName;
    if (url) result.url = url;
    return result;
  }
  return transferView(value);
}

function registerTransferIpc({ ipcMain, invoke }) {
  for (const [channel, [method, keys]] of Object.entries(commands)) ipcMain.handle(`collaboration:${channel}`, (_event, payload) => {
    const value = payload === undefined && keys.length === 0 ? {} : payload;
    const attachmentSend = method === "sendAttachments";
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key))
      || (!attachmentSend && keys.some((key) => !identifier(value[key])))
      || (attachmentSend && (!identifier(value.conversationId) || !Array.isArray(value.transferIds) || value.transferIds.length < 1 || value.transferIds.length > 20 || new Set(value.transferIds).size !== value.transferIds.length || value.transferIds.some((id) => !identifier(id)) || typeof value.bodyText !== "string" || Buffer.byteLength(value.bodyText, "utf8") > 32 * 1024 || (value.clientCommandId != null && !identifier(value.clientCommandId))))) {
      return { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false };
    }
    return invoke(method, value);
  });
}

module.exports = { transferResult, registerTransferIpc };
