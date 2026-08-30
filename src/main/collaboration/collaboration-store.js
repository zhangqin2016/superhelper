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
    return this.db.all(`SELECT id, conversation_id, client_command_id, scope_id, state, attempts, created_at FROM outbox WHERE account_id = ? ORDER BY created_at, id`, this.accountId)
      .map((row) => ({ id: row.id, conversationId: row.conversation_id, clientCommandId: row.client_command_id, scopeId: row.scope_id, state: row.state, attempts: Number(row.attempts), createdAt: row.created_at }));
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
      attempts: Number(row.attempts),
      ...this._decrypt({ scopeId: row.scope_id, recordId: this._outboxRecord(id), value: row.payload_envelope_json }),
    };
  }

  setOutboxState({ outboxId, expectedStates, state }) {
    const id = requireId(outboxId, "outbox id");
    const next = requireId(state, "outbox state");
    const expected = Array.isArray(expectedStates) ? expectedStates.map((value) => requireId(value, "outbox state")) : [];
    if (expected.length === 0) throw new Error("collaboration store: expected outbox states are required");
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db.run(
      `UPDATE outbox SET state = ?, updated_at = ? WHERE account_id = ? AND id = ? AND state IN (${placeholders})`,
      next, this.now(), this.accountId, id, ...expected,
    );
    return result.changes === 1;
  }

  recordOutboxRetry({ outboxId, maxAttempts }) {
    const id = requireId(outboxId, "outbox id");
    const max = Number(maxAttempts);
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("collaboration store: retry limit is invalid");
    const retry = this.db.transaction(() => {
      const row = this.db.get(`SELECT attempts FROM outbox WHERE account_id = ? AND id = ? AND state = 'submitting'`, this.accountId, id);
      if (!row) return null;
      const attempts = Number(row.attempts) + 1;
      const state = attempts >= max ? "paused" : "queued";
      this.db.run(`UPDATE outbox SET attempts = ?, state = ?, updated_at = ? WHERE account_id = ? AND id = ? AND state = 'submitting'`, attempts, state, this.now(), this.accountId, id);
      return { state, attempts };
    });
    return retry();
  }

  settleOutboxFromSync({ clientCommandId, eventId, messageId = null, sequence = null }) {
    const command = requireId(clientCommandId, "client command id");
    const event = requireId(eventId, "event id");
    const settle = this.db.transaction(() => {
      const pending = this.db.get(
        `SELECT 1 AS present FROM outbox WHERE account_id = ? AND client_command_id = ? AND state IN ('queued', 'submitting', 'confirming', 'cancellation_requested', 'cancelled')`,
        this.accountId, command,
      );
      if (pending) this._settleOptimisticCommand({ clientCommandId: command, event: { seq: sequence, payload: { messageId } } });
      return { settled: Boolean(pending), eventId: event };
    });
    return settle();
  }

  getSyncState() {
    const get = this.db.transaction(() => {
      this.db.run(`INSERT OR IGNORE INTO sync_state (account_id, cursor, watermark, updated_at) VALUES (?, 0, 0, ?)`, this.accountId, this.now());
      return this.db.get(`SELECT cursor, watermark FROM sync_state WHERE account_id = ?`, this.accountId);
    });
    const row = get();
    return { cursor: Number(row.cursor), watermark: Number(row.watermark) };
  }

  countAppliedEvents() {
    return Number(this.db.get(`SELECT COUNT(*) AS count FROM applied_events WHERE account_id = ?`, this.accountId)?.count || 0);
  }

  countMessages({ conversationId = null } = {}) {
    if (conversationId == null) return Number(this.db.get(`SELECT COUNT(*) AS count FROM messages WHERE account_id = ?`, this.accountId)?.count || 0);
    return Number(this.db.get(`SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND conversation_id = ?`, this.accountId, requireId(conversationId, "conversation id"))?.count || 0);
  }

  _settleOptimisticCommand({ clientCommandId, event }) {
    const rows = this.db.all(
      `SELECT * FROM outbox WHERE account_id = ? AND client_command_id = ? AND state IN ('queued', 'submitting', 'confirming', 'cancellation_requested', 'cancelled')`,
      this.accountId, clientCommandId,
    );
    for (const outbox of rows) {
      const intent = this._decrypt({ scopeId: outbox.scope_id, recordId: this._outboxRecord(outbox.id), value: outbox.payload_envelope_json });
      const optimisticId = String(intent.messageId || "");
      const serverMessageId = String((event?.payload?.messageId ?? event?.payload?.message_id ?? optimisticId) || "");
      if (optimisticId && serverMessageId) {
        const message = this.db.get(
          `SELECT * FROM messages WHERE account_id = ? AND conversation_id = ? AND id = ?`,
          this.accountId, outbox.conversation_id, optimisticId,
        );
        if (message) {
          const decrypted = this._decrypt({ scopeId: message.scope_id, recordId: this._messageRecord(outbox.conversation_id, optimisticId), value: message.body_envelope_json });
          const serverExists = this.db.get(
            `SELECT 1 AS present FROM messages WHERE account_id = ? AND conversation_id = ? AND id = ?`,
            this.accountId, outbox.conversation_id, serverMessageId,
          );
          if (serverExists && serverMessageId !== optimisticId) {
            // A previous application has already materialized the authoritative
            // row; discard the stale optimistic alias rather than displaying two.
            this.db.run(`DELETE FROM messages WHERE account_id = ? AND conversation_id = ? AND id = ?`, this.accountId, outbox.conversation_id, optimisticId);
          } else {
            this.db.run(
              `UPDATE messages SET id = ?, state = 'persisted', seq = ?, body_envelope_json = ?, updated_at = ? WHERE account_id = ? AND conversation_id = ? AND id = ?`,
              serverMessageId, Number.isSafeInteger(event?.seq) ? event.seq : null,
              this._encrypt({ scopeId: message.scope_id, recordId: this._messageRecord(outbox.conversation_id, serverMessageId), value: decrypted }),
              this.now(), this.accountId, outbox.conversation_id, optimisticId,
            );
          }
        }
      }
      this.db.run(`UPDATE outbox SET state = 'persisted', updated_at = ? WHERE account_id = ? AND id = ?`, this.now(), this.accountId, outbox.id);
    }
  }

  applySyncPage({ fromCursor, toCursor, events, projectEvent = () => {} }) {
    const from = Number(fromCursor);
    const to = Number(toCursor);
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to < from) {
      throw new Error("collaboration store: sync page cursor is invalid");
    }
    const rows = Array.isArray(events) ? events : [];
    const apply = this.db.transaction(() => {
      this.db.run(`INSERT OR IGNORE INTO sync_state (account_id, cursor, watermark, updated_at) VALUES (?, 0, 0, ?)`, this.accountId, this.now());
      const current = this.db.get(`SELECT cursor FROM sync_state WHERE account_id = ?`, this.accountId);
      if (Number(current.cursor) !== from) {
        const error = new Error("collaboration store: sync page does not match local cursor");
        error.code = "COLLAB_SYNC_PAGE_INVALID";
        throw error;
      }
      const appliedEventIds = [];
      for (const row of rows) {
        const id = requireId(row?.id, "event id");
        const inserted = this.db.run(`INSERT OR IGNORE INTO applied_events (account_id, event_id, applied_at) VALUES (?, ?, ?)`, this.accountId, id, this.now());
        if (inserted.changes === 0) continue;
        projectEvent(row);
        this.db.run(
          `INSERT OR IGNORE INTO events (account_id, id, conversation_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          this.accountId, id, row.conversationId == null ? null : String(row.conversationId), Number.isSafeInteger(row.seq) ? row.seq : null,
          requireId(row.type, "event type"), JSON.stringify(row.payload ?? {}), this.now(),
        );
        const command = row?.clientCommandId ?? row?.client_command_id ?? row?.payload?.clientCommandId ?? row?.payload?.client_command_id;
        if (command) {
          this._settleOptimisticCommand({ clientCommandId: String(command), event: row });
        }
        appliedEventIds.push(id);
      }
      this.db.run(`UPDATE sync_state SET cursor = ?, watermark = MAX(watermark, ?), updated_at = ? WHERE account_id = ?`, to, to, this.now(), this.accountId);
      return { cursor: to, appliedEventIds };
    });
    return apply();
  }

  replaceProjectionFromBootstrap({ watermark = 0, profile = null, profiles = [], conversations = [], members = [], history = [] } = {}) {
    const cursor = Number(watermark);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("collaboration store: bootstrap watermark is invalid");
    const rows = Array.isArray(conversations) ? conversations : [];
    const memberRows = Array.isArray(members) ? members : [];
    const historyRows = Array.isArray(history) ? history : [];
    const replace = this.db.transaction(() => {
      const confirmingBubbles = this.db.all(
        `SELECT * FROM outbox WHERE account_id = ? AND state IN ('confirming', 'cancellation_requested') ORDER BY created_at, id`,
        this.accountId,
      ).map((outbox) => ({
        outbox,
        intent: this._decrypt({ scopeId: outbox.scope_id, recordId: this._outboxRecord(outbox.id), value: outbox.payload_envelope_json }),
      }));
      // Only server-rebuildable projection tables for this account are reset.
      // Drafts and the encrypted outbox are intentionally outside this list.
      for (const table of ["conversation_members", "conversations", "events", "messages", "applied_events", "profiles"]) {
        this.db.run(`DELETE FROM ${table} WHERE account_id = ?`, this.accountId);
      }
      for (const conversation of rows) {
        const id = requireId(conversation?.id, "conversation id");
        this.db.run(
          `INSERT INTO conversations (account_id, id, scope_id, kind, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          this.accountId, id, this._scope(conversation.scopeId ?? conversation.scope_id ?? "personal"), String(conversation.kind || "unknown"),
          conversation.title == null ? null : String(conversation.title), this.now(),
        );
      }
      const profileRows = [...(profile ? [profile] : []), ...(Array.isArray(profiles) ? profiles : [])];
      for (const value of profileRows) {
        const userId = requireId(value?.userId ?? value?.user_id, "profile user id");
        this.db.run(
          `INSERT INTO profiles (account_id, user_id, lily_id, display_name, avatar_object_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          this.accountId, userId, value.lilyId ?? value.lily_id ?? null, value.displayName ?? value.display_name ?? null,
          value.avatarObjectId ?? value.avatar_object_id ?? null, this.now(),
        );
      }
      for (const member of memberRows) {
        const conversationId = requireId(member?.conversationId ?? member?.conversation_id, "member conversation id");
        this.db.run(
          `INSERT INTO conversation_members (account_id, conversation_id, user_id, role, status, joined_seq) VALUES (?, ?, ?, ?, ?, ?)`,
          this.accountId, conversationId, requireId(member?.userId ?? member?.user_id, "member user id"), member.role ?? null,
          String(member.status || "active"), Number.isSafeInteger(Number(member.joinedSeq ?? member.joined_seq)) ? Number(member.joinedSeq ?? member.joined_seq) : 0,
        );
      }
      for (const message of historyRows) {
        const conversationId = requireId(message?.conversationId ?? message?.conversation_id, "history conversation id");
        const messageId = requireId(message?.id, "history message id");
        const conversation = this.db.get(`SELECT scope_id FROM conversations WHERE account_id = ? AND id = ?`, this.accountId, conversationId);
        const scopeId = this._scope(message?.scopeId ?? message?.scope_id ?? conversation?.scope_id ?? "personal");
        const bodyText = message?.bodyText ?? message?.body ?? "";
        this.db.run(
          `INSERT INTO messages (account_id, conversation_id, id, scope_id, seq, sender_user_id, state, body_envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'persisted', ?, ?, ?)`,
          this.accountId, conversationId, messageId, scopeId,
          Number.isSafeInteger(Number(message?.createSeq ?? message?.create_seq ?? message?.seq)) ? Number(message?.createSeq ?? message?.create_seq ?? message?.seq) : null,
          message?.senderUserId ?? message?.sender_user_id ?? null,
          this._encrypt({ scopeId, recordId: this._messageRecord(conversationId, messageId), value: { bodyText: String(bodyText) } }), this.now(), this.now(),
        );
      }
      for (const { outbox, intent } of confirmingBubbles) {
        const messageId = String(intent.messageId || "");
        if (!messageId) continue;
        this.db.run(
          `INSERT OR IGNORE INTO messages (account_id, conversation_id, id, scope_id, state, body_envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'optimistic', ?, ?, ?)`,
          this.accountId, outbox.conversation_id, messageId, outbox.scope_id,
          this._encrypt({ scopeId: outbox.scope_id, recordId: this._messageRecord(outbox.conversation_id, messageId), value: { bodyText: String(intent.bodyText || "") } }),
          this.now(), this.now(),
        );
      }
      this.db.run(
        `INSERT INTO sync_state (account_id, cursor, watermark, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor, watermark = excluded.watermark, updated_at = excluded.updated_at`,
        this.accountId, cursor, cursor, this.now(),
      );
      return { cursor };
    });
    return replace();
  }

  listConversationIds() {
    return this.db.all(`SELECT id FROM conversations WHERE account_id = ? ORDER BY id`, this.accountId).map((row) => row.id);
  }

  getProfile({ userId }) {
    const row = this.db.get(`SELECT * FROM profiles WHERE account_id = ? AND user_id = ?`, this.accountId, requireId(userId, "profile user id"));
    if (!row) return null;
    return { userId: row.user_id, lilyId: row.lily_id, displayName: row.display_name, avatarObjectId: row.avatar_object_id };
  }

  listConversationMembers({ conversationId }) {
    return this.db.all(`SELECT * FROM conversation_members WHERE account_id = ? AND conversation_id = ? ORDER BY user_id`, this.accountId, requireId(conversationId, "conversation id"))
      .map((row) => ({ userId: row.user_id, role: row.role, status: row.status, joinedSeq: Number(row.joined_seq) }));
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
