"use strict";

/**
 * Member ids for every conversation, in one query.
 *
 * This exists so a group row can show a composed avatar instead of one initial
 * shared by every group whose title starts with the same character. It is a
 * PRESENTATION input: bounded, ordered, and never a membership decision — the
 * authoritative roster for anything that matters is still read per conversation
 * with the permission checks that go with it.
 *
 * The whole list is read at once rather than per conversation: `listConversations`
 * already pays for a preview, a read watermark and an activity view per row, and
 * one more per-row query on a large account is the kind of cost that shows up as
 * a slow panel open.
 */

/** Enough for a 3x3 tile; more members cannot be distinguished in ~40px. */
const MAX_MEMBERS_PER_CONVERSATION = 9;

function conversationRosters(store, { maxMembers = MAX_MEMBERS_PER_CONVERSATION } = {}) {
  const cap = Number.isSafeInteger(maxMembers) && maxMembers > 0 ? maxMembers : MAX_MEMBERS_PER_CONVERSATION;
  const rosters = new Map();
  let rows;
  try {
    // `status` is 'active' for every persisted row (hydration rejects anything
    // else), so this filter is a statement of intent rather than a filter that
    // currently removes anything.
    rows = store.db.all(
      `SELECT conversation_id, user_id FROM conversation_members
       WHERE account_id = ? AND status = 'active'
       ORDER BY conversation_id ASC, joined_seq ASC, user_id ASC`,
      store.accountId,
    );
  } catch {
    // An avatar is not worth failing a conversation list over.
    return rosters;
  }
  for (const row of rows) {
    const conversationId = row?.conversation_id;
    const userId = row?.user_id;
    if (typeof conversationId !== "string" || typeof userId !== "string") continue;
    const current = rosters.get(conversationId);
    if (!current) { rosters.set(conversationId, [userId]); continue; }
    if (current.length < cap) current.push(userId);
  }
  return rosters;
}

/**
 * The two conversation read projections, moved here with the roster they now
 * carry. They belong together: both assemble the same view of a conversation
 * out of the preview, the read watermark and the activity counters, and the
 * store was at its line ceiling.
 */
function listConversationsView(store, { preview, peerReads, activity }) {
  const rosters = conversationRosters(store);
  return store.db.all(
    `SELECT c.id, c.scope_id, c.kind, c.title, c.updated_at, MAX(m.seq) AS last_seq
     FROM conversations c
     LEFT JOIN messages m ON m.account_id = c.account_id AND m.conversation_id = c.id
     WHERE c.account_id = ?
     GROUP BY c.id, c.scope_id, c.kind, c.title, c.updated_at
     ORDER BY MAX(m.seq) DESC, c.updated_at DESC, c.id ASC`,
    store.accountId,
  ).map((row) => ({
    id: row.id, scopeId: row.scope_id, kind: row.kind, title: row.title,
    updatedAt: Number(row.updated_at),
    lastSeq: row.last_seq == null ? null : Number(row.last_seq),
    lastMessage: preview.conversationPreview(store, row.id),
    peerReadSeq: peerReads.peerReadWatermark(store, row.id),
    memberUserIds: rosters.get(row.id) || [],
    ...activity.activityView(store, row.id),
  }));
}

function getConversationView(store, conversationId, { peerReads, activity }) {
  const row = store.db.get(
    `SELECT id, scope_id, kind, title, updated_at FROM conversations WHERE account_id = ? AND id = ?`,
    store.accountId, conversationId,
  );
  if (!row) return null;
  return {
    id: row.id, scopeId: row.scope_id, kind: row.kind, title: row.title,
    updatedAt: Number(row.updated_at),
    peerReadSeq: peerReads.peerReadWatermark(store, row.id),
    ...activity.activityView(store, row.id),
  };
}

module.exports = { conversationRosters, listConversationsView, getConversationView, MAX_MEMBERS_PER_CONVERSATION };
