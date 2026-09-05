"use strict";

/**
 * Reactions on a message.
 *
 * Mirrors the server projection exactly: one row per (message, user, emoji),
 * so a toggle is an insert or a delete rather than a read-modify-write on an
 * aggregate. Two devices reacting at the same instant therefore cannot clobber
 * each other, and a replayed sync page is idempotent for its own direction.
 *
 * A reaction is NOT a message revision. It has no bearing on edit/revoke
 * conflict detection or on reply snapshots, which is why it lives in its own
 * table instead of as another column on `messages`.
 *
 * Emoji are stored verbatim and never interpreted beyond a length bound, so new
 * emoji need no migration on either side.
 */

const MAX_EMOJI_CHARS = 32;
const MAX_EMOJI_CODEPOINTS = 8;
const MAX_ROWS_PER_MESSAGE = 200;

function validEmoji(value) {
  const emoji = String(value ?? "");
  if (!emoji || emoji.length > MAX_EMOJI_CHARS) return "";
  if ([...emoji].length > MAX_EMOJI_CODEPOINTS || /\s/.test(emoji)) return "";
  return emoji;
}

/** Apply one reaction transition. Returns true when the row set changed. */
function applyReaction(store, { conversationId, messageId, userId, emoji: rawEmoji, active }) {
  const conversation = String(conversationId || "").trim();
  const message = String(messageId || "").trim();
  const user = String(userId || "").trim();
  const emoji = validEmoji(rawEmoji);
  if (!conversation || !message || !user || !emoji) return false;
  if (active === false) {
    store.db.run(
      `DELETE FROM message_reactions WHERE account_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
      store.accountId, message, user, emoji,
    );
    return true;
  }
  // Bound the per-message row count so a hostile peer cannot grow the table
  // without limit; an existing row is always allowed through (idempotent).
  const existing = store.db.get(
    `SELECT 1 AS present FROM message_reactions WHERE account_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
    store.accountId, message, user, emoji,
  );
  if (!existing) {
    const count = store.db.get(
      `SELECT COUNT(*) AS total FROM message_reactions WHERE account_id = ? AND message_id = ?`,
      store.accountId, message,
    );
    if (Number(count?.total || 0) >= MAX_ROWS_PER_MESSAGE) return false;
  }
  store.db.run(
    `INSERT INTO message_reactions (account_id, conversation_id, message_id, user_id, emoji)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, message_id, user_id, emoji) DO NOTHING`,
    store.accountId, conversation, message, user, emoji,
  );
  return true;
}

/**
 * Grouped reactions for a set of messages, ready for the renderer:
 * `{ [messageId]: [{ emoji, count, mine }] }`, ordered by count then emoji so
 * the row is stable across renders.
 */
function reactionsForMessages(store, messageIds) {
  try {
    const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return {};
    const rows = store.db.all(
      `SELECT message_id, emoji, user_id FROM message_reactions
       WHERE account_id = ? AND message_id IN (${ids.map(() => "?").join(",")})`,
      store.accountId, ...ids,
    );
    const grouped = new Map();
    for (const row of rows) {
      const messageId = String(row.message_id);
      if (!grouped.has(messageId)) grouped.set(messageId, new Map());
      const byEmoji = grouped.get(messageId);
      const emoji = String(row.emoji);
      if (!byEmoji.has(emoji)) byEmoji.set(emoji, { emoji, count: 0, mine: false });
      const entry = byEmoji.get(emoji);
      entry.count += 1;
      if (String(row.user_id) === store.accountId) entry.mine = true;
    }
    const out = {};
    for (const [messageId, byEmoji] of grouped) {
      // Tie-break on code points, NOT localeCompare: collation of emoji is
      // locale-dependent, so the chip order would differ between users.
      out[messageId] = [...byEmoji.values()].sort((a, b) => b.count - a.count
        || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0));
    }
    return out;
  } catch {
    return {};
  }
}

/** Attach grouped reactions to a message page, in one query for the page. */
function attachReactions(store, page) {
  const messages = Array.isArray(page) ? page : [];
  if (!messages.length) return messages;
  const grouped = reactionsForMessages(store, messages.map((message) => message.id));
  return messages.map((message) => ({ ...message, reactions: grouped[message.id] || [] }));
}

function forgetReactions(store, conversationId) {
  try {
    if (conversationId == null) {
      store.db.run(`DELETE FROM message_reactions WHERE account_id = ?`, store.accountId);
      return;
    }
    store.db.run(
      `DELETE FROM message_reactions WHERE account_id = ? AND conversation_id = ?`,
      store.accountId, String(conversationId).trim(),
    );
  } catch { /* cleanup is best effort */ }
}

module.exports = {
  MAX_EMOJI_CODEPOINTS, MAX_EMOJI_CHARS, MAX_ROWS_PER_MESSAGE,
  applyReaction, attachReactions, forgetReactions, reactionsForMessages, validEmoji,
};
