"use strict";
const { assertScopeWritable, isConversationRevoked } = require("./access-revocation");
const failure = (code, message) => Object.assign(new Error(message), { code });
function identifier(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value.trim() !== value || value.includes("\0")) {
    throw failure("COLLAB_TASK_RECORD_INVALID", "Invalid task record identifier");
  }
  return value;
}

/** Main-only drafts, workspace bindings and application recovery journals.
 * Callers must project a safe view before exposing any record to a renderer. */
function createTaskRecords({ store, assertActive }) {
  if (!store?.db || typeof assertActive !== "function") throw new TypeError("Task records require a store and active-account guard");
  const accountId = identifier(store.accountId);
  function active() {
    assertActive();
    if (store.accountId !== accountId) throw failure("COLLAB_ACCOUNT_CHANGED", "Task record account changed");
  }
  function scope(conversationId) {
    active(); identifier(conversationId);
    const conversation = store.getConversation({ conversationId });
    if (!conversation || isConversationRevoked(store, conversationId)) throw failure("COLLAB_ACCESS_REVOKED", "Task record access revoked");
    assertScopeWritable(store, conversation.scopeId);
    return conversation.scopeId;
  }
  function binding(row, conversationId, scopeId) {
    if (row.conversation_id !== conversationId || row.scope_id !== scopeId) {
      throw failure("COLLAB_TASK_RECORD_BINDING_CONFLICT", "Task record binding cannot change");
    }
  }
  function decode(row) {
    const scopeId = scope(row.conversation_id);
    binding(row, row.conversation_id, scopeId);
    const value = store._decrypt({ scopeId, recordId: `task-workspace:${row.id}`, value: row.payload_envelope_json });
    if (!value || value.id !== row.id || value.conversationId !== row.conversation_id) {
      throw failure("COLLAB_TASK_RECORD_BINDING_CONFLICT", "Task record encrypted binding does not match");
    }
    active();
    return value;
  }
  return {
    get(id) {
      active(); identifier(id);
      const row = store.db.get("SELECT * FROM task_workspace_records WHERE account_id = ? AND id = ?", accountId, id);
      return row ? decode(row) : null;
    },
    put(id, value) {
      active(); identifier(id);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("COLLAB_TASK_RECORD_INVALID", "Invalid task record value");
      const conversationId = identifier(value.conversationId);
      return store.db.transaction(() => {
        const scopeId = scope(conversationId);
        const existing = store.db.get("SELECT * FROM task_workspace_records WHERE account_id = ? AND id = ?", accountId, id);
        if (existing) binding(existing, conversationId, scopeId);
        const record = { ...value, id, conversationId };
        const envelope = store._encrypt({ scopeId, recordId: `task-workspace:${id}`, value: record });
        active();
        store.db.run(`INSERT INTO task_workspace_records(account_id,id,conversation_id,scope_id,payload_envelope_json,updated_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET payload_envelope_json = excluded.payload_envelope_json, updated_at = excluded.updated_at`,
        accountId, id, conversationId, scopeId, envelope, store.now());
        return record;
      })();
    },
    list(conversationId) {
      scope(conversationId);
      return store.db.all("SELECT * FROM task_workspace_records WHERE account_id = ? AND conversation_id = ? ORDER BY id", accountId, conversationId).map(decode);
    },
  };
}
module.exports = { createTaskRecords };
