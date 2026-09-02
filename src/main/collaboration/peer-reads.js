"use strict";

/**
 * How far the OTHER members have read — the double tick.
 *
 * The server already fans `conversation.read` out to every member of the
 * conversation (`messages.js` attaches `recipientUserIds`), and the client
 * already ingests its OWN read event to advance the unread counter. It simply
 * dropped everyone else's, so an own message could never show as read.
 *
 * Only a sequence number per member is kept. That is strictly less than the
 * read event already carries, and it is monotonic: a lower seq is ignored, so
 * an out-of-order or replayed page can never walk a tick backwards.
 *
 * Mirrors `conversation-activity.js` / `conversation-preview.js`: a focused
 * reader/writer that takes the store instead of another method on it.
 */

/** Record a peer's read watermark. Monotonic — never moves backwards. */
function notePeerRead(store, { conversationId, userId, lastReadSeq }) {
  const conversation = String(conversationId || "").trim();
  const user = String(userId || "").trim();
  const seq = Number(lastReadSeq);
  if (!conversation || !user || !Number.isSafeInteger(seq) || seq < 0) return false;
  if (user === store.accountId) return false;
  store.db.run(
    `INSERT INTO conversation_peer_reads (account_id, conversation_id, user_id, last_read_seq)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, conversation_id, user_id)
       DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
    store.accountId, conversation, user, seq,
  );
  return true;
}

/**
 * The watermark at or below which an own message counts as read by everyone
 * who is expected to read it.
 *
 * A 1:1 has one peer, so its seq IS the watermark. A group needs the MINIMUM
 * across peers who have reported — "read by all" is the only honest meaning of
 * a double tick, and claiming it from the fastest reader would be a lie. A
 * conversation with no reports yet yields 0, i.e. no double ticks, which is
 * exactly today's behaviour.
 */
function peerReadWatermark(store, conversationId) {
  try {
    const conversation = String(conversationId || "").trim();
    if (!conversation) return 0;
    const members = store.listConversationMembers?.({ conversationId: conversation }) || [];
    const peers = members.map((member) => String(member.userId || "")).filter((userId) => userId && userId !== store.accountId);
    const rows = store.db.all(
      `SELECT user_id, last_read_seq FROM conversation_peer_reads WHERE account_id = ? AND conversation_id = ?`,
      store.accountId, conversation,
    );
    if (!rows.length) return 0;
    // Membership unknown (a projection not hydrated yet) means we cannot know
    // WHO still has to read, so there is no honest way to claim read-by-all:
    // no ticks. Falling back to the slowest REPORTER would over-claim, since a
    // peer who never reported would simply not be counted.
    if (!peers.length) return 0;
    const reported = new Map(rows.map((row) => [String(row.user_id), Number(row.last_read_seq) || 0]));
    // A member we know about who has not reported holds the watermark at 0.
    let watermark = Infinity;
    for (const userId of peers) watermark = Math.min(watermark, reported.get(userId) ?? 0);
    return Number.isFinite(watermark) ? watermark : 0;
  } catch {
    return 0;
  }
}

function forgetPeerReads(store, conversationId) {
  try {
    if (conversationId == null) {
      store.db.run(`DELETE FROM conversation_peer_reads WHERE account_id = ?`, store.accountId);
      return;
    }
    store.db.run(
      `DELETE FROM conversation_peer_reads WHERE account_id = ? AND conversation_id = ?`,
      store.accountId, String(conversationId).trim(),
    );
  } catch { /* cleanup is best effort; a stale tick is not a correctness risk */ }
}

module.exports = { forgetPeerReads, notePeerRead, peerReadWatermark };
