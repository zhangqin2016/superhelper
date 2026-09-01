"use strict";

const MAX_EDIT_DRAFT_BYTES = 64 * 1024;

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value;
}

function invalid() {
  return Object.assign(new Error("collaboration edit draft: invalid input"), { code: "COLLABORATION_INVALID_INPUT" });
}

function conflict() {
  return Object.assign(new Error("COLLAB_EDIT_DRAFT_CONFLICT"), { code: "COLLAB_EDIT_DRAFT_CONFLICT" });
}

function editForbidden() {
  return Object.assign(new Error("COLLAB_MESSAGE_EDIT_FORBIDDEN"), { code: "COLLAB_MESSAGE_EDIT_FORBIDDEN" });
}

function baseMismatch() {
  return Object.assign(new Error("COLLAB_EDIT_DRAFT_BASE_MISMATCH"), { code: "COLLAB_EDIT_DRAFT_BASE_MISMATCH" });
}

function normalizeKey({ conversationId, messageId } = {}) {
  if (!validId(conversationId) || !validId(messageId)) throw invalid();
  return { conversationId, messageId };
}

function requireTarget(store, key) {
  const conversation = store.getConversation({ conversationId: key.conversationId });
  const message = conversation && store.getMessage({ conversationId: key.conversationId, messageId: key.messageId });
  if (!conversation || !message) {
    throw Object.assign(new Error("collaboration edit draft: target not found"), { code: "COLLABORATION_NOT_FOUND" });
  }
  if (message.senderUserId !== store.accountId || message.revokedAt) throw editForbidden();
  return { conversation, message };
}

function recordId({ conversationId, messageId }) {
  return `edit-draft:${conversationId}:${messageId}`;
}

function getEditDraft(store, input) {
  const key = normalizeKey(input);
  requireTarget(store, key);
  const row = store.db.get(`SELECT * FROM edit_drafts WHERE account_id = ? AND conversation_id = ? AND message_id = ?`,
    store.accountId, key.conversationId, key.messageId);
  if (!row) return null;
  const value = store._decrypt({ scopeId: row.scope_id, recordId: recordId(key), value: row.content_envelope_json });
  if (typeof value?.bodyText !== "string" || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 1) throw invalid();
  return { ...key, bodyText: value.bodyText, baseRevision: value.baseRevision, generation: Number(row.generation), updatedAt: Number(row.updated_at) };
}

function saveEditDraft(store, input) {
  const key = normalizeKey(input);
  if (typeof input.bodyText !== "string" || Buffer.byteLength(input.bodyText, "utf8") > MAX_EDIT_DRAFT_BYTES
    || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1
    || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) throw invalid();
  const { conversation, message } = requireTarget(store, key);
  const save = store.db.transaction(() => {
    const current = store.db.get(`SELECT generation, scope_id, content_envelope_json FROM edit_drafts WHERE account_id = ? AND conversation_id = ? AND message_id = ?`,
      store.accountId, key.conversationId, key.messageId);
    const generation = current ? Number(current.generation) : 0;
    if (generation !== input.expectedGeneration) throw conflict();
    if (current) {
      const saved = store._decrypt({ scopeId: current.scope_id, recordId: recordId(key), value: current.content_envelope_json });
      if (!Number.isSafeInteger(saved?.baseRevision) || saved.baseRevision < 1) throw invalid();
      if (input.baseRevision !== saved.baseRevision) throw baseMismatch();
    } else if (input.baseRevision !== message.revision) throw baseMismatch();
    const next = generation + 1;
    const at = store.now();
    store.db.run(`INSERT INTO edit_drafts(account_id,conversation_id,message_id,scope_id,generation,content_envelope_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,conversation_id,message_id) DO UPDATE SET
      scope_id=excluded.scope_id,generation=excluded.generation,content_envelope_json=excluded.content_envelope_json,updated_at=excluded.updated_at`,
    store.accountId, key.conversationId, key.messageId, conversation.scopeId, next,
    store._encrypt({ scopeId: conversation.scopeId, recordId: recordId(key), value: { bodyText: input.bodyText, baseRevision: input.baseRevision } }), at);
    return { generation: next, updatedAt: at };
  });
  return save();
}

function clearEditDraft(store, input) {
  const key = normalizeKey(input);
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) throw invalid();
  requireTarget(store, key);
  return store.db.run(`DELETE FROM edit_drafts WHERE account_id = ? AND conversation_id = ? AND message_id = ? AND generation = ?`,
    store.accountId, key.conversationId, key.messageId, input.expectedGeneration).changes === 1;
}

module.exports = { MAX_EDIT_DRAFT_BYTES, getEditDraft, saveEditDraft, clearEditDraft };
