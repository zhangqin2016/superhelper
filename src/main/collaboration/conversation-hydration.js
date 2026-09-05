"use strict";
const { flushRevokedKeys, isConversationRevoked } = require("./access-revocation");
const activity = require("./conversation-activity");
const { randomUUID } = require("node:crypto");
const { confirmRead } = require("./read-checkpoint");
const { notePeerRead } = require("./peer-reads");
const { applyReaction } = require("./message-reactions");
const { resetHistoryGeneration } = require("./history-fence");
const { normalizeMentionCandidates } = require("./mention-candidates");
function invalid() { return Object.assign(new Error("Invalid collaboration conversation projection"), { code: "COLLAB_CONVERSATION_INVALID" }); }
function id(value) { return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value); }
function queueAuthorizedRefresh(store, conversationId) {
  store.db.run(`INSERT INTO conversation_hydration (account_id, conversation_id, created_at, generation) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id,conversation_id) DO UPDATE SET generation=excluded.generation`, store.accountId, conversationId, store.now(), randomUUID());
}
function assertHydrationComplete(store) {
  if (store.db?.get(`SELECT 1 FROM conversation_hydration WHERE account_id=? LIMIT 1`, store.accountId)) throw Object.assign(invalid(), { code: "COLLAB_CONVERSATION_STALE" });
}

function queueConversationHydration(store, event) {
  const conversationId = event.conversationId ?? event.conversation_id;
  if (!conversationId) return;
  if (["member.removed", "member.left"].includes(event.type) && event.payload?.userId === store.accountId) return;
  if (event.type === "conversation.dissolved") return;
  const discovery = event.type === "conversation.created" || String(event.type).startsWith("member.");
  const unknownMessage = String(event.type).startsWith("message.") && !store.getConversation({ conversationId }) && !isConversationRevoked(store, conversationId);
  const actorUserId = event.actorUserId ?? event.actor_user_id;
  const ownRead = event.type === "conversation.read" && actorUserId === store.accountId && !isConversationRevoked(store, conversationId);
  // Another member's read event is what makes the double tick possible. It was
  // dropped here, which is why an own message could never show as read.
  const peerRead = event.type === "conversation.read" && actorUserId && actorUserId !== store.accountId
    && !isConversationRevoked(store, conversationId);
  const reaction = event.type === "message.reaction";
  if (!discovery && !unknownMessage && !ownRead && !peerRead && !reaction) return;
  if (!id(conversationId)) throw invalid();
  if (ownRead) confirmRead(store, conversationId, event.payload?.lastReadSeq, null, true);
  // A reaction changes no message revision and needs no authorized refresh, so
  // it is applied straight to the local projection.
  if (event.type === "message.reaction" && !isConversationRevoked(store, conversationId)) {
    if (!id(conversationId)) throw invalid();
    applyReaction(store, {
      conversationId,
      messageId: event.payload?.messageId,
      userId: event.payload?.userId ?? actorUserId,
      emoji: event.payload?.emoji,
      active: event.payload?.active,
    });
    return;
  }
  if (peerRead) {
    notePeerRead(store, { conversationId, userId: actorUserId, lastReadSeq: event.payload?.lastReadSeq });
    // A peer read changes only the tick, so it must not queue an authorized
    // refresh: that would turn every read receipt into a network round trip.
    return;
  }
  if (discovery && event.payload?.userId === store.accountId) resetHistoryGeneration(store, conversationId);
  queueAuthorizedRefresh(store, conversationId);
}

function normalizeProjection(value, conversationId, accountId) {
  const c = value?.conversation;
  if (!c || c.id !== conversationId || !id(c.id)) throw invalid();
  activity.normalizeActivity(c);
  const scopeType = c.scopeType ?? c.scope_type;
  const organizationId = c.organizationId ?? c.organization_id ?? null;
  const scopeId = scopeType === "organization" && id(organizationId) ? `team:${organizationId}` : scopeType === "personal" && organizationId == null ? "personal" : null;
  if (!scopeId || c.scopeId != null && c.scopeId !== scopeId || !["direct", "group", "channel"].includes(c.kind)
      || scopeType === "personal" && c.kind === "channel" || scopeType === "organization" && c.kind === "group"
      || c.kind === "channel" && !["public", "private"].includes(c.visibility)) throw invalid();
  if (!Array.isArray(value.members) || value.members.length > 1000 || !Array.isArray(value.profiles) || value.profiles.length > 1001) throw invalid();
  const members = value.members.map((m) => ({ userId: m.userId ?? m.user_id, conversationId: m.conversationId ?? m.conversation_id, status: m.status, role: m.role, joinedSeq: Number(m.joinedSeq ?? m.joined_seq) }));
  if (members.some((m) => m.conversationId !== conversationId || !id(m.userId) || m.status !== "active" || !["owner", "admin", "member"].includes(m.role) || !Number.isSafeInteger(m.joinedSeq) || m.joinedSeq < 0) || new Set(members.map((m) => m.userId)).size !== members.length) throw invalid();
  const self = members.find((m) => m.userId === accountId);
  if (c.visibility !== "public" && !self) throw invalid();
  const profiles = value.profiles.map((p) => ({ userId: p.userId ?? p.user_id, lilyId: p.lilyId ?? p.lily_id ?? null, displayName: p.displayName ?? p.display_name ?? null, avatarObjectId: p.avatarObjectId ?? p.avatar_object_id ?? null,
    loginName: p.loginName ?? p.login_name ?? null, phoneMasked: p.phoneMasked ?? p.phone_masked ?? null }));
  if (profiles.some((p) => !id(p.userId) || p.userId !== accountId && !members.some((m) => m.userId === p.userId))) throw invalid();
  const publicTeam = scopeType === "organization" && c.kind === "channel" && c.visibility === "public";
  const mentionCandidates = normalizeMentionCandidates(value.mentionCandidates, { memberIds: publicTeam ? null : new Set(members.map((m) => m.userId)) });
  return { id: conversationId, scopeId, kind: c.kind, title: String(c.title || "").slice(0, 200), members, profiles, self, mentionCandidates };
}

function applyAuthorizedConversation(store, conversationId, value) {
  const normalized = normalizeProjection(value, conversationId, store.accountId);
  const previous = store.getConversation({ conversationId });
  if (previous && previous.scopeId !== normalized.scopeId) throw invalid();
  flushRevokedKeys(store);
  store.db.transaction(() => {
    activity.resetMembershipReadState(store, conversationId, normalized.members);
    const priorSelf = store.listConversationMembers({ conversationId }).find((m) => m.userId === store.accountId);
    if (priorSelf && normalized.self?.joinedSeq > priorSelf.joinedSeq) {
      // A new membership epoch cannot inherit pre-removal drafts or messages;
      // retain current sync targets, which will be freshly authorized below.
      for (const table of ["messages", "drafts", "edit_drafts", "outbox"]) store.db.run(`DELETE FROM ${table} WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId);
    }
    store.db.run(`DELETE FROM revoked_scopes WHERE account_id = ? AND scope_id = ?`, store.accountId, normalized.scopeId);
    store.db.run(`DELETE FROM revoked_conversations WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId);
    store.db.run(`INSERT INTO conversations (account_id, id, scope_id, kind, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, id) DO UPDATE SET kind=excluded.kind, title=excluded.title, updated_at=excluded.updated_at`, store.accountId, conversationId, normalized.scopeId, normalized.kind, normalized.title, store.now());
    if (!previous || priorSelf && normalized.self?.joinedSeq > priorSelf.joinedSeq) resetHistoryGeneration(store, conversationId);
    store.db.run(`DELETE FROM conversation_members WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId);
    for (const m of normalized.members) store.db.run(`INSERT INTO conversation_members (account_id,conversation_id,user_id,status,role,joined_seq) VALUES (?, ?, ?, ?, ?, ?)`, store.accountId, conversationId, m.userId, m.status, m.role, m.joinedSeq);
    for (const p of normalized.profiles) store.db.run(`INSERT INTO profiles (account_id,user_id,lily_id,display_name,avatar_object_id,login_name,phone_masked,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id,user_id) DO UPDATE SET lily_id=excluded.lily_id,display_name=excluded.display_name,avatar_object_id=excluded.avatar_object_id,login_name=excluded.login_name,phone_masked=excluded.phone_masked,updated_at=excluded.updated_at`, store.accountId, p.userId, p.lilyId, p.displayName, p.avatarObjectId, p.loginName, p.phoneMasked, store.now());
    const freshActivity = activity.applyActivitySnapshot(store, conversationId, value.conversation);
    if (!freshActivity) queueAuthorizedRefresh(store, conversationId);
    store.db.run(`INSERT OR IGNORE INTO history_hydration (account_id,conversation_id,created_at) VALUES (?, ?, ?)`, store.accountId, conversationId, store.now());
    if (freshActivity) store.db.run(`DELETE FROM conversation_hydration WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId);
  })();
}

async function recoverConversationHydration({ store, client, deviceId, assertActive, recoverDeniedHistory }) {
  if (!store.db) return;
  const pending = store.db.all(`SELECT conversation_id, generation FROM conversation_hydration WHERE account_id = ? ORDER BY created_at, conversation_id`, store.accountId);
  if (pending.length && typeof client?.getConversationProjection !== "function") throw invalid();
  for (const row of pending) {
    try {
      assertActive();
      const value = await client.getConversationProjection({ deviceId, conversationId: row.conversation_id });
      assertActive();
      const current = store.db.get(`SELECT generation FROM conversation_hydration WHERE account_id=? AND conversation_id=?`, store.accountId, row.conversation_id);
      if (!current || current.generation !== row.generation) continue;
      applyAuthorizedConversation(store, row.conversation_id, value);
    } catch (error) {
      assertActive();
      if (!recoverDeniedHistory(row.conversation_id, error)) throw error;
    }
  }
  assertHydrationComplete(store);
}
module.exports = { queueConversationHydration, queueAuthorizedRefresh, assertHydrationComplete, normalizeProjection, applyAuthorizedConversation, recoverConversationHydration };
