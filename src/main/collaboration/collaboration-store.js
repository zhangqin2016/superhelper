"use strict";

const crypto = require("node:crypto");
const { collaborationDbPath } = require("../config");
const { openDatabase } = require("../store/sqlite-db");
const { COLLABORATION_MIGRATIONS } = require("./schema");

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!id || id.length > 512) throw new Error(`collaboration store: ${label} is required`);
  return id;
}

function parseEnvelope(value) {
  try { return JSON.parse(value); } catch { throw new Error("collaboration store: encrypted payload is invalid"); }
}

class CollaborationStore {
  constructor({ dbPath = collaborationDbPath(), accountId, keyring, now = () => Date.now() } = {}) {
    this.accountId = requireId(accountId, "account id");
    if (!keyring || typeof keyring.encrypt !== "function" || typeof keyring.decrypt !== "function") {
      throw new Error("collaboration store: a local keyring is required");
    }
    this.keyring = keyring;
    this.now = now;
    this.db = openDatabase(dbPath);
    this.db.migrate(COLLABORATION_MIGRATIONS);
  }

  _scope(scopeId) { return requireId(scopeId || "personal", "scope id"); }
  _draftRecord(conversationId, draftId) { return `draft:${conversationId}:${draftId}`; }
  _messageRecord(conversationId, messageId) { return `message:${conversationId}:${messageId}`; }
  _outboxRecord(outboxId) { return `outbox:${outboxId}`; }
  _encrypt({ scopeId, recordId, value }) {
    return JSON.stringify(this.keyring.encrypt({ accountId: this.accountId, scopeId, recordId, plaintext: JSON.stringify(value) }));
  }
  _decrypt({ scopeId, recordId, value }) {
    return JSON.parse(this.keyring.decrypt({ accountId: this.accountId, scopeId, recordId, envelope: parseEnvelope(value) }));
  }

  persistDraftAndOptimisticMessage({ conversationId, draftId, draftText, messageId, clientCommandId, bodyText, scopeId = "personal", afterCommit } = {}) {
    const conversation = requireId(conversationId, "conversation id");
    const draft = requireId(draftId, "draft id");
    const message = requireId(messageId, "message id");
    const command = requireId(clientCommandId, "client command id");
    const scope = this._scope(scopeId);
    const outboxId = command;
    const at = this.now();
    const create = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO drafts (account_id, conversation_id, id, scope_id, content_envelope_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, conversation_id, id) DO UPDATE SET scope_id = excluded.scope_id, content_envelope_json = excluded.content_envelope_json, updated_at = excluded.updated_at`,
        this.accountId, conversation, draft, scope,
        this._encrypt({ scopeId: scope, recordId: this._draftRecord(conversation, draft), value: { text: String(draftText || "") } }), at,
      );
      this.db.run(
        `INSERT INTO messages (account_id, conversation_id, id, scope_id, state, body_envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'optimistic', ?, ?, ?)`,
        this.accountId, conversation, message, scope,
        this._encrypt({ scopeId: scope, recordId: this._messageRecord(conversation, message), value: { bodyText: String(bodyText || "") } }), at, at,
      );
      this.db.run(
        `INSERT INTO outbox (account_id, id, conversation_id, client_command_id, scope_id, state, payload_envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        this.accountId, outboxId, conversation, command, scope,
        this._encrypt({ scopeId: scope, recordId: this._outboxRecord(outboxId), value: { messageId: message, clientCommandId: command, bodyText: String(bodyText || "") } }), at, at,
      );
      return { outboxId };
    });
    const result = create();
    if (typeof afterCommit === "function") afterCommit({ ...result, clientCommandId: command });
    return result;
  }

  getDraft({ conversationId, draftId }) {
    const conversation = requireId(conversationId, "conversation id");
    const draft = requireId(draftId, "draft id");
    const row = this.db.get(`SELECT * FROM drafts WHERE account_id = ? AND conversation_id = ? AND id = ?`, this.accountId, conversation, draft);
    if (!row) return null;
    return { id: row.id, conversationId: row.conversation_id, ...this._decrypt({ scopeId: row.scope_id, recordId: this._draftRecord(conversation, draft), value: row.content_envelope_json }), updatedAt: row.updated_at };
  }

  getMessage({ conversationId, messageId }) {
    const conversation = requireId(conversationId, "conversation id");
    const message = requireId(messageId, "message id");
    const row = this.db.get(`SELECT * FROM messages WHERE account_id = ? AND conversation_id = ? AND id = ?`, this.accountId, conversation, message);
    if (!row) return null;
    return { id: row.id, conversationId: row.conversation_id, state: row.state, seq: row.seq, ...this._decrypt({ scopeId: row.scope_id, recordId: this._messageRecord(conversation, message), value: row.body_envelope_json }) };
  }

  listOutbox() {
    return this.db.all(`SELECT id, conversation_id, client_command_id, scope_id, state, created_at FROM outbox WHERE account_id = ? ORDER BY created_at, id`, this.accountId)
      .map((row) => ({ id: row.id, conversationId: row.conversation_id, clientCommandId: row.client_command_id, scopeId: row.scope_id, state: row.state, createdAt: row.created_at }));
  }

  getOutbox({ outboxId }) {
    const id = requireId(outboxId, "outbox id");
    const row = this.db.get(`SELECT * FROM outbox WHERE account_id = ? AND id = ?`, this.accountId, id);
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      clientCommandId: row.client_command_id,
      scopeId: row.scope_id,
      state: row.state,
      ...this._decrypt({ scopeId: row.scope_id, recordId: this._outboxRecord(id), value: row.payload_envelope_json }),
    };
  }

  /** Remove only retryable outbound intent; projections remain recoverable. */
  revokeScope({ scopeId }) {
    const scope = this._scope(scopeId);
    const remove = this.db.transaction(() => {
      const outbox = this.db.run(`DELETE FROM outbox WHERE account_id = ? AND scope_id = ?`, this.accountId, scope);
      return { deletedOutbox: outbox.changes };
    });
    const result = remove();
    this.keyring.destroyScopeKey({ accountId: this.accountId, scopeId: scope });
    return result;
  }

  close() { this.db.close(); }
}

/**
 * Collaboration is an additive desktop capability. Its cache can always be
 * rebuilt from the server, so a corrupt/busy local database must fail inside
 * this boundary rather than poisoning Electron startup or the AI transcript
 * store. Callers receive a stable capability result and may keep the rest of
 * the workbench running normally.
 */
function openCollaborationStore(options = {}) {
  const { createStore = (input) => new CollaborationStore(input), ...storeOptions } = options;
  try {
    return { ok: true, store: createStore(storeOptions) };
  } catch {
    return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  }
}

module.exports = { CollaborationStore, openCollaborationStore };
