"use strict";

function invalidHistory() { return Object.assign(new Error("Invalid collaboration history target"), { code: "COLLAB_HISTORY_INVALID" }); }

/** Called inside the page transaction; ACK recovery must survive a process exit. */
function queueHistoryTarget(store, event) {
  if (!String(event?.type || "").startsWith("message.")) return;
  const conversationId = event.conversationId ?? event.conversation_id;
  const messageId = event.payload?.messageId ?? event.payload?.message_id;
  if (messageId == null || !conversationId) return; // Older event versions use conversation hydration.
  const mutation = ["message.edited", "message.revoked"].includes(event.type);
  const revision = Number(event.payload?.revision ?? (mutation ? NaN : 1));
  if (typeof messageId !== "string" || !messageId.trim() || messageId.length > 200 || !Number.isSafeInteger(revision) || revision < 1) throw invalidHistory();
  if (mutation && revision < 2) throw invalidHistory();
  store.db.run(`INSERT INTO history_hydration_targets (account_id, conversation_id, message_id, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`, store.accountId, conversationId, messageId, revision);
}

function listHistoryTargets(store, conversationId) {
  return store.db.all(`SELECT message_id AS messageId, revision FROM history_hydration_targets WHERE account_id = ? AND conversation_id = ? ORDER BY message_id`, store.accountId, conversationId);
}

/** Preserve only existing, bounded pending targets across a bootstrap reset. */
function capturePendingHistoryTargets(store) {
  return store.db.all(`SELECT conversation_id AS conversationId, message_id AS messageId, revision
    FROM history_hydration_targets WHERE account_id = ? ORDER BY conversation_id, message_id`, store.accountId);
}

function restorePendingHistoryTargets(store, targets, visibleConversationIds) {
  const visible = new Set(visibleConversationIds);
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!visible.has(target.conversationId)) continue;
    store.db.run(`INSERT OR IGNORE INTO history_hydration (account_id, conversation_id, created_at) VALUES (?, ?, ?)`, store.accountId, target.conversationId, store.now());
    store.db.run(`INSERT INTO history_hydration_targets (account_id, conversation_id, message_id, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`, store.accountId, target.conversationId, target.messageId, target.revision);
  }
}

function completeHistoryHydration(store, conversationId, completedTargets = []) {
  return store.db.transaction(() => {
    for (const target of Array.isArray(completedTargets) ? completedTargets : []) {
      if (!target?.messageId || !Number.isSafeInteger(Number(target.revision))) continue;
      // A receipt may have raised this target while an older history request
      // was in flight. Delete only the exact generation this request proved.
      store.db.run(`DELETE FROM history_hydration_targets WHERE account_id = ? AND conversation_id = ? AND message_id = ? AND revision <= ?`,
        store.accountId, conversationId, target.messageId, Number(target.revision));
    }
    const remaining = Number(store.db.get(`SELECT COUNT(*) AS count FROM history_hydration_targets WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId)?.count || 0);
    const completed = remaining === 0
      ? Number(store.db.run(`DELETE FROM history_hydration WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId).changes || 0)
      : 0;
    return { completed };
  })();
}

async function hydratePendingConversation({ store, client, deviceId, conversationId, assertActive }) {
  const targets = listHistoryTargets(store, conversationId);
  const batches = targets.length ? Array.from({ length: Math.ceil(targets.length / 200) }, (_, i) => targets.slice(i * 200, (i + 1) * 200)) : [null];
  for (const batch of batches) {
    const response = await client.listMessageHistory({ deviceId, conversationId, ...(batch ? { messageIds: batch.map((row) => row.messageId) } : {}) });
    assertActive();
    const messages = Array.isArray(response) ? response : response?.messages ?? response?.items;
    const unavailable = response?.unavailableMessageIds ?? [];
    if (!Array.isArray(messages) || messages.length > 200) throw invalidHistory();
    if (batch) {
      const wanted = new Map(batch.map((row) => [row.messageId, Number(row.revision)]));
      if (!Array.isArray(unavailable) || messages.length + unavailable.length !== wanted.size) throw invalidHistory();
      for (const row of messages) {
        const seq = Number(row.createSeq ?? row.create_seq ?? row.seq);
        if (row.conversationId !== conversationId) throw invalidHistory();
        if (!wanted.has(row.id) || !Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < wanted.get(row.id)) throw invalidHistory();
        wanted.delete(row.id);
      }
      for (const id of unavailable) {
        if (!wanted.has(id)) throw invalidHistory();
        wanted.delete(id);
      }
    }
    store.db.transaction(() => {
      store.hydrateAuthorizedHistory({ conversationId, messages, completeCheckpoint: false });
      // A signed, freshly authorized target response explicitly proves these
      // IDs are not visible (or no longer exist). A merely missing row does not.
      if (batch) for (const id of unavailable) store.db.run(`DELETE FROM messages WHERE account_id = ? AND conversation_id = ? AND id = ?`, store.accountId, conversationId, id);
    })();
  }
  // Completion is generation-conditional: a newer receipt can arrive while a
  // previously issued authorized history request is still in flight.
  completeHistoryHydration(store, conversationId, targets);
}

module.exports = { queueHistoryTarget, listHistoryTargets, capturePendingHistoryTargets, restorePendingHistoryTargets, completeHistoryHydration, hydratePendingConversation };
