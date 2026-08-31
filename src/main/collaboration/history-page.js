"use strict";

const PAGE_SIZE = 200;
const OFFLINE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "COLLAB_NETWORK_UNAVAILABLE", "COLLAB_RESPONSE_UNKNOWN"]);
function invalidHistory() { return Object.assign(new Error("Invalid collaboration history page"), { code: "COLLAB_HISTORY_INVALID" }); }
function sequence(row) { return Number(row.createSeq ?? row.create_seq ?? row.seq); }
function pageCursor(messages) {
  const seqs = messages.filter((row) => row.seq != null).map((row) => Number(row.seq));
  return seqs.length ? Math.min(...seqs) : null;
}

/** One authorized keyset page; a cache window is never called a full archive. */
async function readHistoryPage({ store, client, deviceId, conversationId, beforeSeq, assertActive = () => {} }) {
  if (beforeSeq != null && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) throw invalidHistory();
  let offline = !client || !deviceId || typeof client.listMessageHistory !== "function";
  let messages;
  let hasMore;
  if (!offline) {
    try {
      const response = await client.listMessageHistory({ deviceId, conversationId, beforeSeq, limit: PAGE_SIZE });
      assertActive();
      const rows = Array.isArray(response) ? response : response?.messages ?? response?.items;
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw invalidHistory();
      const ids = new Set(), seqs = new Set();
      for (const row of rows) {
        const seq = sequence(row);
        if (!row.id || ids.has(row.id) || seqs.has(seq) || !Number.isSafeInteger(seq) || seq < 1 || (beforeSeq != null && seq >= beforeSeq)) throw invalidHistory();
        ids.add(row.id); seqs.add(seq);
      }
      store.hydrateAuthorizedHistory({ conversationId, messages: rows, completeCheckpoint: beforeSeq == null });
      messages = rows.map((row) => ({ ...row, ...store.getMessage({ conversationId, messageId: row.id }),
        seq: sequence(row), senderUserId: row.senderUserId ?? row.sender_user_id ?? null,
      })).sort((a, b) => a.seq - b.seq);
      if (beforeSeq == null) messages.push(...store.listMessages({ conversationId }).filter((row) => row.seq == null));
      // The bounded pending tail is separate from the authorized history
      // window; it must not evict a server row or skip its pagination cursor.
      hasMore = rows.length === PAGE_SIZE;
    } catch (error) {
      if (!OFFLINE_CODES.has(error?.code)) throw error;
      offline = true;
    }
  }
  assertActive();
  if (offline) {
    messages = store.listMessages({ conversationId, beforeSeq, limit: PAGE_SIZE, includePending: false });
    hasMore = messages.length === PAGE_SIZE;
    if (beforeSeq == null) messages.push(...store.listMessages({ conversationId }).filter((row) => row.seq == null));
  }
  return { messages, nextBeforeSeq: pageCursor(messages), hasMore, offline };
}

module.exports = { readHistoryPage };
