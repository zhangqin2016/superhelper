"use strict";
const { messageIdentifier } = require("./message-intent");
const AVAILABLE = ["status", "messageId", "revision", "senderUserId", "createSeq", "kind", "bodyText", "truncated"];
function invalid() { return Object.assign(new Error("Invalid collaboration reply snapshot"), { code: "COLLAB_HISTORY_INVALID" }); }
function only(value, fields) { return Object.keys(value).every((key) => fields.includes(key)); }

/** Server-owned display data, never part of a create/edit command or draft. */
function normalizeReplySnapshot(message) {
  const value = message.replySnapshot;
  if (value === undefined) return message.replyToMessageId ? { status: "unavailable", reason: "legacy" } : null;
  if (value === null) {
    if (message.replyToMessageId) throw invalid();
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) throw invalid();
  if (value.status === "available") {
    if (!only(value, AVAILABLE) || !messageIdentifier(value.messageId) || value.messageId !== message.replyToMessageId
      || !messageIdentifier(value.senderUserId) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isSafeInteger(value.createSeq) || value.createSeq < 1 || !["text", "attachment", "workspace_share"].includes(value.kind)
      || typeof value.bodyText !== "string" || Buffer.byteLength(value.bodyText, "utf8") > 2048 || [...value.bodyText].length > 512
      || typeof value.truncated !== "boolean" || message.revokedAt) throw invalid();
    return Object.fromEntries(AVAILABLE.map((key) => [key, value[key]]));
  }
  if (value.status === "revoked" && only(value, ["status"])) return { status: "revoked" };
  if (value.status === "unavailable" && only(value, ["status", "reason"]) && (value.reason === undefined || value.reason === "legacy")) {
    return { status: "unavailable", ...(value.reason ? { reason: value.reason } : {}) };
  }
  throw invalid();
}

/** Fixed-size metadata per source. Caller supplies the sync/history transaction. */
function maskReplySource(store, conversationId, messageId, status) {
  if (!messageIdentifier(messageId) || !["revoked", "unavailable"].includes(status)) throw invalid();
  store.db.run(`INSERT INTO reply_source_masks (account_id, conversation_id, message_id, status) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET status = CASE WHEN status = 'unavailable' THEN status ELSE excluded.status END`,
  store.accountId, conversationId, messageId, status);
}

function replySnapshotView(store, conversationId, message) {
  const snapshot = normalizeReplySnapshot(message);
  if (message.revokedAt) return snapshot == null ? null : { status: "unavailable" };
  if (snapshot == null || snapshot.status === "unavailable" || !message.replyToMessageId) return snapshot;
  const mask = store.db.get(`SELECT status FROM reply_source_masks WHERE account_id = ? AND conversation_id = ? AND message_id = ?`,
    store.accountId, conversationId, message.replyToMessageId);
  return mask ? { status: mask.status } : snapshot;
}

function recordHistoryReplyMasks(store, conversationId, message, snapshot, prior) {
  if (message.revokedAt) maskReplySource(store, conversationId, message.id, "revoked");
  // Legacy/own-revoked replies say nothing about the visibility of their source.
  if (!message.revokedAt && snapshot && snapshot.status !== "available" && !snapshot.reason) {
    const source = message.replyToMessageId || prior?.replyToMessageId;
    if (source) maskReplySource(store, conversationId, source, snapshot.status);
  }
}

module.exports = { normalizeReplySnapshot, maskReplySource, replySnapshotView, recordHistoryReplyMasks };
