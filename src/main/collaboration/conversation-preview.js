"use strict";

/**
 * Last-message preview for a conversation list row.
 *
 * A chat list whose second line is the conversation's SCOPE ("个人" / a team
 * name) tells the user nothing — it is constant per row. Every mainstream
 * messenger shows the newest message there instead. The body already lives in
 * this account's local encrypted cache and the store owns the decrypt, so this
 * is a local read: nothing new leaves the device.
 *
 * Mirrors `conversation-activity.js`: a focused reader that takes the store
 * rather than another method on it.
 *
 * Fail-open by contract — an unreadable or blank body yields null and the row
 * falls back to what it displayed before. A missing key must never take the
 * whole conversation list down with it.
 */

const MAX_PREVIEW_CHARS = 160;

function conversationPreview(store, conversationId) {
  try {
    const row = store.db.get(
      `SELECT m.id, m.scope_id, m.sender_user_id, m.body_envelope_json
       FROM messages m
       LEFT JOIN outbox o ON o.account_id = m.account_id AND o.client_command_id = m.client_command_id
       WHERE m.account_id = ? AND m.conversation_id = ?
         AND COALESCE(o.state, '') <> 'cancelled' AND COALESCE(m.state, '') <> 'cancelled'
       ORDER BY (m.seq IS NULL) DESC, m.seq DESC, m.created_at DESC, m.rowid DESC LIMIT 1`,
      store.accountId, conversationId,
    );
    if (!row) return null;
    const content = store._decrypt({
      scopeId: row.scope_id,
      recordId: store._messageRecord(conversationId, row.id),
      value: row.body_envelope_json,
    });
    const text = String(content?.bodyText || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { senderUserId: row.sender_user_id || "", text: text.slice(0, MAX_PREVIEW_CHARS) };
  } catch {
    return null;
  }
}

module.exports = { MAX_PREVIEW_CHARS, conversationPreview };
