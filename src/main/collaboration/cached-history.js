"use strict";
const { isConversationRevoked } = require("./access-revocation");

// A synchronous preview cannot queue behind HTTP. Only an intact local
// projection is eligible; uncertain/revoked projections use normal open.
function cachedHistory(store, conversationId) {
  if (!store.db || isConversationRevoked(store, conversationId)) return { ok: false, code: "COLLAB_CACHE_UNAVAILABLE" };
  const conversation = store.getConversation({ conversationId });
  if (!conversation || store.db.get("SELECT 1 FROM revoked_scopes WHERE account_id=? AND scope_id=?", store.accountId, conversation.scopeId)) return { ok: false, code: "COLLAB_CACHE_UNAVAILABLE" };
  for (const table of ["conversation_hydration", "history_hydration", "history_hydration_targets"]) {
    if (store.db.get(`SELECT 1 FROM ${table} WHERE account_id=? AND conversation_id=? LIMIT 1`, store.accountId, conversationId)) return { ok: false, code: "COLLAB_CACHE_UNAVAILABLE" };
  }
  const messages = store.listMessages({ conversationId, limit: 200, includePending: false });
  const seqs = messages.map((m) => Number(m.seq)).filter((n) => Number.isSafeInteger(n) && n > 0);
  const hasMore = messages.length === 200;
  messages.push(...store.listMessages({ conversationId }).filter((m) => m.seq == null));
  return { ok: true, conversation, messages, hasMore, nextBeforeSeq: seqs.length ? Math.min(...seqs) : null, offline: true };
}
module.exports = { cachedHistory };
