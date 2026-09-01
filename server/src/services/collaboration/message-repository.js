import { sql } from "kysely";
import { createKyselyConversationRepository } from "./conversation-repository.js";

export function createKyselyMessageRepository(db) {
  const conversations = createKyselyConversationRepository(db);
  return {
    activeConversationMemberIds: conversations.activeConversationMemberIds,
    async findReplyTarget(trx, { conversationId, replyToMessageId, visibleAfterSeq }) {
      return trx.selectFrom("messages").select(["id", "conversation_id", "revoked_at", "create_seq", "sender_user_id", "revision", "kind", "body_ciphertext", "body_key_version"])
        .where("id", "=", replyToMessageId).where("conversation_id", "=", conversationId).where("create_seq", ">", visibleAfterSeq).executeTakeFirst();
    },
    async findReplySources(trx, { conversationId, messageIds }) {
      return trx.selectFrom("messages").select(["id", "conversation_id", "revoked_at", "create_seq", "sender_user_id"])
        .where("conversation_id", "=", conversationId).where("id", "in", messageIds).execute();
    },
    async findAttachments(trx, { attachmentIds }) {
      // No FOR UPDATE here: send preflight is read-only; bindToMessage owns the
      // ordered message -> object locks after the message has been inserted.
      return trx.selectFrom("stored_objects").select(["id", "state", "owner_user_id as ownerUserId", "conversation_id as conversationId", "purpose", "bound_message_id as boundMessageId", "expires_at as expiresAt", "orphan_expires_at as orphanExpiresAt"]).where("id", "in", attachmentIds).execute();
    },
    async insertMessage(trx, message) { await trx.insertInto("messages").values({ id: message.id, event_id: message.eventId, conversation_id: message.conversationId, create_seq: message.createSeq, sender_user_id: message.senderUserId, kind: message.kind, body_ciphertext: message.bodyCiphertext, body_key_version: message.bodyKeyVersion, revision: message.revision, reply_to_message_id: message.replyToMessageId, reply_snapshot_ciphertext: message.replySnapshotCiphertext, reply_snapshot_key_version: message.replySnapshotKeyVersion }).execute(); },
    async findMessageForUpdate(trx, { conversationId, messageId }) { const row = await trx.selectFrom("messages").selectAll().where("id", "=", messageId).where("conversation_id", "=", conversationId).forUpdate().executeTakeFirst(); return row && { id: row.id, conversationId: row.conversation_id, senderUserId: row.sender_user_id, revision: row.revision, revokedAt: row.revoked_at, createdAt: row.created_at }; },
    async compareAndSwapMessage(trx, { conversationId, messageId, expectedRevision, patch }) { return trx.updateTable("messages").set({ body_ciphertext: patch.bodyCiphertext, body_key_version: patch.bodyKeyVersion, reply_snapshot_ciphertext: patch.replySnapshotCiphertext, reply_snapshot_key_version: patch.replySnapshotKeyVersion, revoked_at: patch.revokedAt, edited_at: patch.editedAt, revision: sql`revision + 1` }).where("id", "=", messageId).where("conversation_id", "=", conversationId).where("revision", "=", expectedRevision).returningAll().executeTakeFirst(); },
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
    async listHistory(trx, { conversationId, beforeSeq, messageIds, limit, visibleAfterSeq }) {
      const rows = await trx.selectFrom("messages").selectAll()
        .select(sql`coalesce((select creation.payload -> 'mentionUserIds' from collaboration_events as creation
          where creation.id = messages.event_id and creation.conversation_id = messages.conversation_id and creation.type = 'message.created'), '[]'::jsonb)`.as("mentionUserIds"))
        .select(sql`(select creation.client_command_id from collaboration_events as creation
          where creation.id = messages.event_id and creation.conversation_id = messages.conversation_id and creation.type = 'message.created')`.as("clientCommandId"))
        .where("conversation_id", "=", conversationId).where("create_seq", ">", visibleAfterSeq).$if(beforeSeq != null, (q) => q.where("create_seq", "<", beforeSeq)).$if(messageIds != null, (q) => q.where("id", "in", messageIds)).orderBy("create_seq", "desc").limit(limit).execute();
      const attachmentMessageIds = rows.filter((row) => row.kind === "attachment" || row.kind === "workspace_share").map((row) => row.id);
      // The text-only baseline does not depend on object migrations or keys.
      if (!attachmentMessageIds.length) return rows;
      const attachments = await trx.selectFrom("message_attachments").select(["message_id", "object_id", "sort_order"]).where("message_id", "in", attachmentMessageIds).orderBy("sort_order", "asc").execute();
      const byMessage = new Map();
      for (const attachment of attachments) {
        if (!byMessage.has(attachment.message_id)) byMessage.set(attachment.message_id, []);
        byMessage.get(attachment.message_id).push(attachment.object_id);
      }
      return rows.map((row) => ({ ...row, attachmentIds: byMessage.get(row.id) || [] }));
    },
  };
}

export function createLockedMessageAuthorizer() {
  return (input) => createKyselyConversationRepository(input.trx).authorizeAction(input);
}
