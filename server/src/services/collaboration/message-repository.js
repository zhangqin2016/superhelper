import { sql } from "kysely";
import { createKyselyConversationRepository } from "./conversation-repository.js";

export function createKyselyMessageRepository(db) {
  const conversations = createKyselyConversationRepository(db);
  return {
    activeConversationMemberIds: conversations.activeConversationMemberIds,
    async findReplyTarget(trx, { conversationId, replyToMessageId }) { const row = await trx.selectFrom("messages").selectAll().where("id", "=", replyToMessageId).where("conversation_id", "=", conversationId).executeTakeFirst(); return row && { id: row.id, conversationId: row.conversation_id, revokedAt: row.revoked_at }; },
    async findAttachments() { return []; },
    async insertMessage(trx, message) { await trx.insertInto("messages").values({ id: message.id, event_id: message.eventId, conversation_id: message.conversationId, create_seq: message.createSeq, sender_user_id: message.senderUserId, kind: message.kind, body_ciphertext: message.bodyCiphertext, body_key_version: message.bodyKeyVersion, revision: message.revision, reply_to_message_id: message.replyToMessageId }).execute(); },
    async findMessageForUpdate(trx, { conversationId, messageId }) { const row = await trx.selectFrom("messages").selectAll().where("id", "=", messageId).where("conversation_id", "=", conversationId).forUpdate().executeTakeFirst(); return row && { id: row.id, conversationId: row.conversation_id, senderUserId: row.sender_user_id, revision: row.revision, revokedAt: row.revoked_at, createdAt: row.created_at }; },
    async compareAndSwapMessage(trx, { conversationId, messageId, expectedRevision, patch }) { return trx.updateTable("messages").set({ body_ciphertext: patch.bodyCiphertext, body_key_version: patch.bodyKeyVersion, revoked_at: patch.revokedAt, edited_at: patch.editedAt, revision: sql`revision + 1` }).where("id", "=", messageId).where("conversation_id", "=", conversationId).where("revision", "=", expectedRevision).returningAll().executeTakeFirst(); },
    async insertMessageRevision(trx, revision) { await trx.insertInto("message_revisions").values({ id: revision.id, message_id: revision.messageId, event_id: revision.eventId, conversation_id: revision.conversationId, event_seq: revision.eventSeq, body_ciphertext: revision.bodyCiphertext, key_version: revision.keyVersion }).execute(); },
    async resolveLastReadSeq(trx, { conversationId, userId, submittedSeq }) {
      const conversation = await trx.selectFrom("conversations").select("next_seq").where("id", "=", conversationId).executeTakeFirstOrThrow();
      const membership = await trx.selectFrom("conversation_members").select("last_read_seq").where("conversation_id", "=", conversationId).where("user_id", "=", userId).executeTakeFirst();
      return Math.max(Number(membership?.last_read_seq || 0), Math.min(submittedSeq, Math.max(0, Number(conversation.next_seq) - 1)));
    },
    async advanceLastReadSeq(trx, { conversationId, userId, submittedSeq }) {
      const conversation = await trx.selectFrom("conversations").select(["visibility", "next_seq"]).where("id", "=", conversationId).executeTakeFirstOrThrow();
      const seq = Math.min(submittedSeq, Math.max(0, Number(conversation.next_seq) - 1));
      if (conversation.visibility === "public") {
        return trx.insertInto("conversation_members").values({ conversation_id: conversationId, user_id: userId, role: "member", status: "active", joined_seq: 0, last_read_seq: seq })
          .onConflict((c) => c.columns(["conversation_id", "user_id"]).doUpdateSet({ status: "active", last_read_seq: sql`greatest(conversation_members.last_read_seq, ${seq})` }))
          .returning(["last_read_seq as lastReadSeq"]).executeTakeFirstOrThrow();
      }
      return trx.updateTable("conversation_members").set({ last_read_seq: sql`greatest(last_read_seq, ${seq})` }).where("conversation_id", "=", conversationId).where("user_id", "=", userId).where("status", "=", "active").returning(["last_read_seq as lastReadSeq"]).executeTakeFirstOrThrow();
    },
    async listHistory(trx, { conversationId, beforeSeq, messageIds, limit, visibleAfterSeq }) { return trx.selectFrom("messages").selectAll().where("conversation_id", "=", conversationId).where("create_seq", ">", visibleAfterSeq).$if(beforeSeq != null, (q) => q.where("create_seq", "<", beforeSeq)).$if(messageIds != null, (q) => q.where("id", "in", messageIds)).orderBy("create_seq", "desc").limit(limit).execute(); },
  };
}

export function createLockedMessageAuthorizer() {
  return (input) => createKyselyConversationRepository(input.trx).authorizeAction(input);
}
