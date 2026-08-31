"use strict";

const commands = Object.freeze({
  "get-transfers": ["getTransfers", []],
  "prepare-attachment": ["prepareAttachment", ["conversationId"]],
  "enqueue-transfer": ["enqueueTransfer", ["transferId"]],
  "pause-transfer": ["pauseTransfer", ["transferId"]],
  "cancel-transfer": ["cancelTransfer", ["transferId"]],
  "prepare-download": ["prepareDownload", ["conversationId", "messageId", "objectId"]],
  "save-download": ["saveDownload", ["transferId"]],
});
const methods = new Set(Object.values(commands).map(([method]) => method));
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const number = (value) => Number.isSafeInteger(value) && value >= 0;
const code = (value) => typeof value === "string" && value.length <= 100 && /^(COLLAB[A-Z_]*|LILYENC_[A-Z_]+)$/.test(value);

function transferView(value = {}) {
  const result = { ok: value.ok === true };
  for (const key of ["id", "conversationId", "objectId"]) if (identifier(value[key])) result[key] = value[key];
  for (const key of ["totalBytes", "completedParts", "attempts", "nextAttemptAt", "bytes"]) if (number(value[key])) result[key] = value[key];
  if (typeof value.scopeId === "string" && value.scopeId.length <= 210 && /^(personal|team:[A-Za-z0-9_-]+)$/.test(value.scopeId)) result.scopeId = value.scopeId;
  if (["upload", "download"].includes(value.direction)) result.direction = value.direction;
  if (["attachment", "workspace"].includes(value.purpose)) result.purpose = value.purpose;
  if (["queued", "prepared", "encrypting", "uploading", "uploaded", "verifying", "verified", "bound", "downloading", "decrypting", "ready", "paused", "failed", "cancelled"].includes(value.state)) result.state = value.state;
  if (typeof value.originalName === "string" && value.originalName.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(value.originalName)) result.originalName = value.originalName;
  for (const key of ["automaticRetry", "serverCancelled", "retryable", "cancelled", "saved"]) if (typeof value[key] === "boolean") result[key] = value[key];
  if (code(value.code)) result.code = value.code;
  return result;
}

function transferResult(method, value) {
  if (!methods.has(method)) return null;
  if (method === "getTransfers" && value?.ok === true) return { ok: true, transfers: (Array.isArray(value.transfers) ? value.transfers : []).map(transferView),
    unrecognizedCount: number(value.unrecognizedCount) ? value.unrecognizedCount : 0 };
  return transferView(value);
}

function registerTransferIpc({ ipcMain, invoke }) {
  for (const [channel, [method, keys]] of Object.entries(commands)) ipcMain.handle(`collaboration:${channel}`, (_event, payload) => {
    const value = payload === undefined && keys.length === 0 ? {} : payload;
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !identifier(value[key]))) {
      return { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false };
    }
    return invoke(method, value);
  });
}

module.exports = { transferResult, registerTransferIpc };
