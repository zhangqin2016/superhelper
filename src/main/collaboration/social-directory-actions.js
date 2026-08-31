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
async function getConversationDetails({ store, client, deviceId, conversationId, assertActive, recoverDeniedHistory }) {
  if (!client?.getConversationProjection || !deviceId) return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  try {
    const value = await client.getConversationProjection({ deviceId, conversationId });
    assertActive();
    const normalized = normalizeProjection(value, conversationId, store.accountId);
    applyAuthorizedConversation(store, conversationId, value);
    const visibility = value.conversation.visibility || null;
    return { ok: true, conversation: { id: normalized.id, scopeId: normalized.scopeId, kind: normalized.kind, title: normalized.title }, visibility,
      // UI affordance only. Every mutation is separately server-authorized.
      canManage: normalized.kind !== "direct" && visibility !== "public" && ["owner", "admin"].includes(normalized.self?.role),
      members: normalized.members.map((m) => ({ userId: m.userId, role: m.role,
        displayName: normalized.profiles.find((p) => p.userId === m.userId)?.displayName || "", lilyId: normalized.profiles.find((p) => p.userId === m.userId)?.lilyId || "" })),
    };
  } catch (error) {
    assertActive();
    if (recoverDeniedHistory(conversationId, error)) return { ok: false, code: "COLLAB_ACCESS_REVOKED" };
    return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  }
}
module.exports = { visibleConversations, openFriend, getConversationDetails };
