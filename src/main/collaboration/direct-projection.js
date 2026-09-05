"use strict";

function invalid() { throw new Error("collaboration direct projection: invalid accepted conversation"); }
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value; }

/** Called within applySyncPage's SQLite transaction, never as a second commit. */
function projectAcceptedDirect(store, event) {
  if (event.type !== "friend.accepted") return;
  const payload = event.payload || {};
  const direct = payload.directConversation;
  // Older servers can omit this additive projection. They still advance the
  // durable cursor and use an explicit bootstrap for discovery.
  if (!direct) return;
  const ids = direct.participantUserIds;
  if (!validId(direct.id) || direct.id !== event.conversationId || direct.scopeType !== "personal" || direct.kind !== "direct"
      || !Array.isArray(ids) || ids.length !== 2 || !ids.every(validId) || ids[0] === ids[1] || !ids.includes(store.accountId)
      || !ids.includes(event.actorUserId) || !Array.isArray(payload.participantUserIds)
      || payload.participantUserIds.length !== 2 || !ids.every((id) => payload.participantUserIds.includes(id))) invalid();
  const existing = store.getConversation({ conversationId: direct.id });
  if (existing && (existing.scopeId !== "personal" || existing.kind !== "direct")) invalid();
  if (store.listConversationMembers({ conversationId: direct.id }).some((member) => !ids.includes(member.userId))) invalid();
  store.db.run(`INSERT INTO conversations (account_id, id, scope_id, kind, title, updated_at)
    VALUES (?, ?, 'personal', 'direct', '', ?) ON CONFLICT(account_id, id) DO NOTHING`, store.accountId, direct.id, store.now());
  for (const userId of ids) {
    store.db.run(`INSERT INTO conversation_members (account_id, conversation_id, user_id, role, status, joined_seq)
      VALUES (?, ?, ?, 'member', 'active', 0) ON CONFLICT(account_id, conversation_id, user_id) DO UPDATE SET status = 'active'`,
    store.accountId, direct.id, userId);
    const profile = payload.profilesByUserId?.[userId];
    if (!profile) continue;
    if (profile.userId !== userId) invalid();
    store.db.run(`INSERT INTO profiles (account_id, user_id, lily_id, display_name, avatar_object_id, login_name, phone_masked, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, user_id) DO UPDATE SET
      lily_id = excluded.lily_id, display_name = excluded.display_name, avatar_object_id = excluded.avatar_object_id,
      login_name = coalesce(excluded.login_name, profiles.login_name), phone_masked = coalesce(excluded.phone_masked, profiles.phone_masked), updated_at = excluded.updated_at`,
    store.accountId, userId, profile.lilyId ?? null, profile.displayName ?? null, profile.avatarObjectId ?? null, profile.loginName ?? null, profile.phoneMasked ?? null, store.now());
  }
}

module.exports = { projectAcceptedDirect };
