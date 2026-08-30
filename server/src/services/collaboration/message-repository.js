import { sql } from "kysely";
import { authorizeCollaborationAction } from "./authorization.js";

export function createKyselyMessageRepository(db) {
  return {
    async activeConversationMemberIds(trx, { conversationId }) { return (await trx.selectFrom("conversation_members").select("user_id").where("conversation_id", "=", conversationId).where("status", "=", "active").orderBy("user_id").execute()).map((row) => row.user_id); },
    async findReplyTarget(trx, { conversationId, replyToMessageId }) { const row = await trx.selectFrom("messages").selectAll().where("id", "=", replyToMessageId).where("conversation_id", "=", conversationId).executeTakeFirst(); return row && { id: row.id, conversationId: row.conversation_id, revokedAt: row.revoked_at }; },
    async findAttachments() { return []; },
    async insertMessage(trx, message) { await trx.insertInto("messages").values({ id: message.id, event_id: message.eventId, conversation_id: message.conversationId, create_seq: message.createSeq, sender_user_id: message.senderUserId, kind: message.kind, body_ciphertext: message.bodyCiphertext, body_key_version: message.bodyKeyVersion, revision: message.revision, reply_to_message_id: message.replyToMessageId }).execute(); },
    async findMessageForUpdate(trx, { conversationId, messageId }) { const row = await trx.selectFrom("messages").selectAll().where("id", "=", messageId).where("conversation_id", "=", conversationId).forUpdate().executeTakeFirst(); return row && { id: row.id, conversationId: row.conversation_id, senderUserId: row.sender_user_id, revision: row.revision, revokedAt: row.revoked_at, createdAt: row.created_at }; },
    async compareAndSwapMessage(trx, { conversationId, messageId, expectedRevision, patch }) { return trx.updateTable("messages").set({ body_ciphertext: patch.bodyCiphertext, body_key_version: patch.bodyKeyVersion, revoked_at: patch.revokedAt, edited_at: patch.editedAt, revision: sql`revision + 1` }).where("id", "=", messageId).where("conversation_id", "=", conversationId).where("revision", "=", expectedRevision).returningAll().executeTakeFirst(); },
    async insertMessageRevision(trx, revision) { await trx.insertInto("message_revisions").values({ id: revision.id, message_id: revision.messageId, event_id: revision.eventId, conversation_id: revision.conversationId, event_seq: revision.eventSeq, body_ciphertext: revision.bodyCiphertext, key_version: revision.keyVersion }).execute(); },
    async advanceLastReadSeq(trx, { conversationId, userId, submittedSeq }) { return trx.updateTable("conversation_members").set({ last_read_seq: sql`greatest(last_read_seq, ${submittedSeq})` }).where("conversation_id", "=", conversationId).where("user_id", "=", userId).where("status", "=", "active").returning(["last_read_seq as lastReadSeq"]).executeTakeFirst(); },
    async listHistory(trx, { conversationId, beforeSeq, limit, visibleAfterSeq }) { return trx.selectFrom("messages").selectAll().where("conversation_id", "=", conversationId).where("create_seq", ">", visibleAfterSeq).$if(beforeSeq != null, (q) => q.where("create_seq", "<", beforeSeq)).orderBy("create_seq", "desc").limit(limit).execute(); },
  };
}

export function createLockedMessageAuthorizer() {
  return async ({ trx, account, input, action = "send" }) => {
    const device = await trx.selectFrom("user_devices").select("device_id").where("user_id", "=", account.userId).where("device_id", "=", account.deviceId).where("status", "=", "active").forUpdate().executeTakeFirst();
    if (!device) return { ok: false, code: "COLLAB_DEVICE_REVOKED", auditReason: "device-inactive" };
    const conversation = await trx.selectFrom("conversations").selectAll().where("id", "=", input.conversationId).forUpdate().executeTakeFirst();
    const membership = conversation && await trx.selectFrom("conversation_members").selectAll().where("conversation_id", "=", conversation.id).where("user_id", "=", account.userId).forUpdate().executeTakeFirst();
    let friendshipStatus = "active"; let blocked = false;
    if (conversation?.scope_type === "personal" && conversation.kind === "direct") {
      const peerUserId = conversation.direct_user_low_id === account.userId ? conversation.direct_user_high_id : conversation.direct_user_low_id;
      const friendship = await trx.selectFrom("friendships").select("status").where("user_low_id", "=", conversation.direct_user_low_id).where("user_high_id", "=", conversation.direct_user_high_id).forUpdate().executeTakeFirst();
      friendshipStatus = friendship?.status || "removed";
      blocked = Boolean(await trx.selectFrom("user_blocks").select("blocker_user_id").where((eb) => eb.or([eb.and([eb("blocker_user_id", "=", account.userId), eb("blocked_user_id", "=", peerUserId)]), eb.and([eb("blocker_user_id", "=", peerUserId), eb("blocked_user_id", "=", account.userId)])])).forUpdate().executeTakeFirst());
    }
    let organizationStatus; let organizationMembership; let peerOrganizationMembershipStatus;
    if (conversation?.scope_type === "organization") {
      const organization = await trx.selectFrom("organizations").select("status").where("id", "=", conversation.organization_id).forUpdate().executeTakeFirst();
      const orgMembers = await trx.selectFrom("organization_members").selectAll().where("organization_id", "=", conversation.organization_id).where("user_id", "in", [account.userId, conversation.direct_user_low_id, conversation.direct_user_high_id].filter(Boolean)).forUpdate().execute();
      organizationStatus = organization?.status; organizationMembership = orgMembers.find((row) => row.user_id === account.userId);
      const peer = conversation.direct_user_low_id === account.userId ? conversation.direct_user_high_id : conversation.direct_user_low_id;
      peerOrganizationMembershipStatus = peer ? orgMembers.find((row) => row.user_id === peer)?.status : "active";
    }
    const decision = authorizeCollaborationAction({ actorUserId: account.userId, conversation: conversation && { scopeType: conversation.scope_type, kind: conversation.kind }, authorization: { conversationMembership: membership && { userId: membership.user_id, status: membership.status, role: membership.role }, friendshipStatus, blocked, organizationStatus, organizationMembership: organizationMembership && { userId: organizationMembership.user_id, status: organizationMembership.status, role: organizationMembership.role }, peerOrganizationMembershipStatus } }, action);
    return decision.ok ? { ...decision, visibleAfterSeq: Number(membership?.joined_seq || 0) } : decision;
  };
}
