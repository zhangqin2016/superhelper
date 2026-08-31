"use strict";
const { releaseHandledClamp } = require("./read-checkpoint");

function attachmentIds(message) {
  const ids = message.attachmentIds === undefined ? [] : message.attachmentIds;
  if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length
    || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) {
    throw Object.assign(new Error("Invalid collaboration attachment history"), { code: "COLLAB_HISTORY_INVALID" });
  }
  return message.revokedAt ? [] : [...ids];
}

/** Persist only the server's authorized plaintext history view, encrypted locally. */
function hydrateAuthorizedHistory(store, { conversation, messages = [], completeCheckpoint = true }) {
  const target = store.db.get(`SELECT scope_id FROM conversations WHERE account_id = ? AND id = ?`, store.accountId, conversation);
  if (!target) return { hydrated: 0 };
  const rows = Array.isArray(messages) ? messages : [];
  const apply = store.db.transaction(() => {
    let hydrated = 0;
    for (const message of rows) {
      const id = String(message?.id || "").trim();
      if (!id || id.length > 512) throw new Error("collaboration store: history message id is required");
      if (message.conversationId != null && message.conversationId !== conversation) throw new Error("collaboration store: history conversation mismatch");
      const revision = Number(message.revision ?? 1);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("collaboration store: invalid history revision");
      const normalizedAttachments = attachmentIds(message);
      const prior = store.getMessage({ conversationId: conversation, messageId: id });
      // Different fetches can finish out of order. Never resurrect an old
      // revision or overwrite a revocation with stale authorized history.
      if (prior && (Number(prior.revision || 1) > revision || prior.revokedAt && !message.revokedAt)) continue;
      const content = {
        bodyText: message.revokedAt ? "" : String(message.bodyText ?? ""), revision,
        replyToMessageId: message.replyToMessageId ?? null, revokedAt: message.revokedAt ?? null,
        editedAt: message.editedAt ?? null, kind: String(message.kind || "text"),
        attachmentIds: normalizedAttachments,
        ...(prior?.clientCommandId ? { clientCommandId: prior.clientCommandId } : {}),
      };
      const seq = Number(message?.createSeq ?? message?.create_seq ?? message?.seq);
      store.db.run(
        `INSERT INTO messages (account_id, conversation_id, id, scope_id, seq, sender_user_id, state, body_envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'persisted', ?, ?, ?)
         ON CONFLICT(account_id, conversation_id, id) DO UPDATE SET seq = excluded.seq, sender_user_id = excluded.sender_user_id, state = excluded.state, body_envelope_json = excluded.body_envelope_json, updated_at = excluded.updated_at`,
        store.accountId, conversation, id, target.scope_id, Number.isSafeInteger(seq) ? seq : null, message?.senderUserId ?? message?.sender_user_id ?? null,
        store._encrypt({ scopeId: target.scope_id, recordId: store._messageRecord(conversation, id), value: content }), store.now(), store.now(),
      );
      releaseHandledClamp(store, conversation, seq);
      hydrated += 1;
    }
    return { hydrated };
  });
  const result = apply();
  if (completeCheckpoint) {
    const returnedRevisions = new Map(rows.map((message) => [String(message?.id || ""), Number(message?.revision ?? 1)]));
    const completedTargets = store.listHistoryTargets({ conversationId: conversation })
      .filter((target) => Number.isSafeInteger(returnedRevisions.get(target.messageId)) && returnedRevisions.get(target.messageId) >= Number(target.revision));
    store.completeHistoryHydration({ conversationId: conversation, completedTargets });
  }
  return result;
}

function backfillMessageCommandIds(store) {
  const rows = store.db.all(`SELECT id, conversation_id, scope_id, body_envelope_json FROM messages
    WHERE account_id = ? AND client_command_id IS NULL AND seq IS NULL`, store.accountId);
  if (!rows.length) return;
  store.db.transaction(() => {
    const byMessage = new Map();
    for (const item of store.listOutbox()) {
      const intent = store.getOutbox({ outboxId: item.id });
      if (intent.commandType !== "message.create") continue;
      byMessage.set(JSON.stringify([item.conversationId, intent.messageId]), item.clientCommandId);
    }
    for (const row of rows) {
      const commandId = byMessage.get(JSON.stringify([row.conversation_id, row.id]));
      if (commandId) store.db.run(`UPDATE messages SET client_command_id = ? WHERE account_id = ? AND conversation_id = ? AND id = ?`, commandId, store.accountId, row.conversation_id, row.id);
    }
  })();
}

module.exports = { hydrateAuthorizedHistory, backfillMessageCommandIds, attachmentIds };
