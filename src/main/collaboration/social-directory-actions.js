"use strict";
const { normalizeProjection, applyAuthorizedConversation } = require("./conversation-hydration");

function visibleConversations(store) {
  const blocked = new Set((store.getDirectory?.().contacts || []).filter((c) => c.ownBlocked).map((c) => c.userId));
  return store.listConversations().filter((c) => c.kind !== "direct" || !(store.listConversationMembers?.({ conversationId: c.id }) || []).some((m) => blocked.has(m.userId)));
}
function openFriend(store, { peerUserId }) {
  const contact = store.getDirectory().contacts.find((c) => c.userId === peerUserId);
  if (!contact || contact.relationship !== "friend" || contact.ownBlocked) return { ok: false, code: "COLLAB_FRIEND_TARGET_UNAVAILABLE" };
  const conversation = visibleConversations(store).find((c) => {
    if (c.kind !== "direct" || c.scopeId !== "personal") return false;
    const members = store.listConversationMembers({ conversationId: c.id }).filter((m) => m.status === "active");
    return members.length === 2 && members.some((m) => m.userId === peerUserId) && members.some((m) => m.userId === store.accountId);
  });
  return conversation ? { ok: true, conversationId: conversation.id } : { ok: false, code: "COLLABORATION_NOT_FOUND" };
}
async function getConversationDetails({ store, client, deviceId, conversationId, assertActive, recoverDeniedHistory, candidateCache }) {
  if (!client?.getConversationProjection || !deviceId) return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  candidateCache?.discard(conversationId);
  const assertCurrent = candidateCache?.capture(conversationId) || (() => {});
  try {
    const value = await client.getConversationProjection({ deviceId, conversationId });
    assertActive(); assertCurrent();
    const normalized = normalizeProjection(value, conversationId, store.accountId);
    applyAuthorizedConversation(store, conversationId, value);
    candidateCache?.put(conversationId, normalized.mentionCandidates);
    const visibility = value.conversation.visibility || null;
    return { ok: true, conversation: { id: normalized.id, scopeId: normalized.scopeId, kind: normalized.kind, title: normalized.title }, visibility, mentionCandidates: normalized.mentionCandidates,
      // UI affordance only. Every mutation is separately server-authorized.
      canManage: normalized.kind !== "direct" && visibility !== "public" && ["owner", "admin"].includes(normalized.self?.role),
      members: normalized.members.map((m) => ({ userId: m.userId, role: m.role,
        displayName: normalized.profiles.find((p) => p.userId === m.userId)?.displayName || "", lilyId: normalized.profiles.find((p) => p.userId === m.userId)?.lilyId || "" })),
    };
  } catch (error) {
    assertActive();
    try { assertCurrent(); } catch { return { ok: false, code: "COLLAB_CONVERSATION_STALE" }; }
    if (recoverDeniedHistory(conversationId, error)) return { ok: false, code: "COLLAB_ACCESS_REVOKED" };
    return { ok: false, code: ["COLLAB_MENTION_CANDIDATES_INVALID", "COLLAB_MENTION_CANDIDATES_LIMIT"].includes(error?.code) ? error.code : "COLLABORATION_UNAVAILABLE" };
  }
}
async function getMentionCandidates(options) {
  const { conversationId, candidateCache } = options;
  try {
    const cached = candidateCache.get(conversationId);
    if (cached) return { ok: true, conversationId, mentionCandidates: cached };
  } catch (error) { return { ok: false, code: error.code || "COLLABORATION_UNAVAILABLE" }; }
  const details = await getConversationDetails(options);
  return details.ok ? { ok: true, conversationId, mentionCandidates: details.mentionCandidates } : details;
}
module.exports = { visibleConversations, openFriend, getConversationDetails, getMentionCandidates };
