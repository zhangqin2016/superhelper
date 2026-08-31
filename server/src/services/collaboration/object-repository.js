import { sql } from "kysely";
import { authorizeCollaborationAction } from "./authorization.js";
import { lockAuthorizationRows } from "./lock-order.js";
import { createKyselyConversationRepository } from "./conversation-repository.js";
import { canTransitionObject } from "./objects.js";

const denied = () => ({ ok: false, code: "COLLAB_OBJECT_UNAVAILABLE", auditReason: "object-unavailable", retryable: false });
const failure = () => Object.assign(new Error("COLLAB_OBJECT_UNAVAILABLE"), { code: "COLLAB_OBJECT_UNAVAILABLE", retryable: false });
const expired = (value, now) => value != null && (!Number.isFinite(new Date(value).getTime()) || new Date(value).getTime() <= now);

/** SQL operations share the caller transaction; none can silently open a commit. */
export function createKyselyObjectRepository(database, { conversations = createKyselyConversationRepository(database), now = Date.now } = {}) {
  async function lockConversation(trx, { account, conversationId, action = "send" }) {
    const device = await conversations.lockDevice(trx, account);
    if (!device.ok) return device;
    const context = await conversations.lockConversationContext(trx, { actorUserId: account.userId, conversationId });
    if (context.decision) return context.decision;
    return { ...authorizeCollaborationAction(context, action), context };
  }
  async function authorizeObject(trx, { account, objectId, action = "owner" }) {
    // Hints select immutable lock routing only. All values are rechecked after
    // scope/conversation -> message -> object locks have been acquired.
    const hint = await trx.selectFrom("stored_objects").selectAll().where("id", "=", objectId).executeTakeFirst();
    if (!hint) return denied();
    const scope = await lockConversation(trx, { account, conversationId: hint.conversation_id, action: "read" });
    if (!scope.ok) return denied();
    const locks = await lockAuthorizationRows(trx, { messageIds: hint.bound_message_id ? [hint.bound_message_id] : [], objectIds: [objectId] });
    const object = locks.object[0];
    if (!object || ["conversation_id", "owner_user_id", "scope_type", "organization_id", "bound_message_id"].some((key) => object[key] !== hint[key])) return denied();
    const { context } = scope;
    if (object.scope_type !== context.conversation.scopeType || object.organization_id !== context.conversation.organizationId || expired(object.expires_at, Number(now()))) return denied();
    if (action === "owner") return object.owner_user_id === account.userId ? { ok: true, object, context } : denied();
    const message = locks.message[0];
    const limitedHistory = context.conversation.scopeType === "personal" && context.conversation.kind === "group" || context.conversation.visibility === "private";
    const boundary = limitedHistory ? Number(context.authorization.conversationMembership?.joined_seq || 0) : 0;
    const retentionDays = Number(context.row.retention_days || 0);
    if (object.state !== "bound" || !message || message.id !== object.bound_message_id || message.conversation_id !== object.conversation_id || message.revoked_at || Number(message.create_seq) <= boundary || retentionDays > 0 && new Date(message.created_at).getTime() + retentionDays * 86_400_000 <= Number(now())) return denied();
    const attachment = await trx.selectFrom("message_attachments").select("object_id").where("object_id", "=", objectId).where("message_id", "=", message.id).executeTakeFirst();
    if (!attachment) return denied();
    const decision = authorizeCollaborationAction({ ...context, authorization: { ...context.authorization, objectStatus: "completed" } }, "download");
    return decision.ok ? { ...decision, object, context, message } : denied();
  }
  async function transition(trx, objectId, from, to, patch = {}) {
    if (!canTransitionObject(from, to)) throw failure();
    const updated = await trx.updateTable("stored_objects").set({ ...patch, state: to, updated_at: sql`now()` }).where("id", "=", objectId).where("state", "=", from).returningAll().executeTakeFirst();
    if (!updated) throw failure();
    return updated;
  }
  return Object.freeze({ database, conversations, requireId: conversations.requireId, lockConversation, authorizeObject, transition,
    async withTransaction(callback) {
      return database.transaction().execute(async (trx) => {
        await sql`set local lock_timeout = '2s'`.execute(trx);
        await sql`set local statement_timeout = '8s'`.execute(trx);
        return callback(trx);
      });
    },
    async insertObject(trx, object, envelope) {
      await trx.insertInto("stored_objects").values({ id: object.objectId, owner_user_id: object.ownerUserId, conversation_id: object.conversationId, scope_type: object.scopeType, organization_id: object.organizationId, purpose: object.purpose, object_key: object.objectKey, state: "initiated", ciphertext_size: object.ciphertextSize, ciphertext_sha256: object.ciphertextSha256, mime_type: object.mimeType, original_name: object.originalName, expires_at: object.expiresAt }).execute();
      await trx.insertInto("object_keys").values({ object_id: object.objectId, wrapped_dek: envelope.wrappedDek, kek_version: envelope.kekVersion, algorithm: envelope.algorithm }).execute();
    },
    async findKey(trx, objectId) {
      const row = await trx.selectFrom("object_keys").selectAll().where("object_id", "=", objectId).executeTakeFirst();
      return row && { wrappedDek: row.wrapped_dek, kekVersion: row.kek_version, algorithm: row.algorithm };
    },
    async queueCleanup(trx, objectId, reason) {
      await trx.deleteFrom("object_keys").where("object_id", "=", objectId).execute();
      // Upload credentials cannot be remotely revoked. Wait out their maximum
      // 15-minute lifetime before deleting ciphertext, preventing late commits
      // from recreating an object after its only cleanup job already finished.
      await trx.insertInto("object_cleanup_jobs").values({ object_id: objectId, reason, available_at: sql`now() + interval '16 minutes'` }).onConflict((conflict) => conflict.column("object_id").doNothing()).execute();
    },
    async bindObjects(trx, { account, conversationId, messageId, objectIds, purpose }) {
      if (trx?.isTransaction !== true) throw Object.assign(new Error("COLLAB_OBJECT_TRANSACTION_REQUIRED"), { code: "COLLAB_OBJECT_TRANSACTION_REQUIRED" });
      const scope = await lockConversation(trx, { account, conversationId, action: "send" });
      if (!scope.ok) throw Object.assign(new Error(scope.code), scope);
      const locks = await lockAuthorizationRows(trx, { messageIds: [messageId], objectIds });
      const message = locks.message[0];
      if (!message || message.conversation_id !== conversationId || message.sender_user_id !== account.userId || message.revoked_at || locks.object.length !== objectIds.length) throw failure();
      for (const object of locks.object) {
        if (object.state !== "verified" || object.bound_message_id || object.owner_user_id !== account.userId || object.conversation_id !== conversationId || object.scope_type !== scope.context.conversation.scopeType || object.organization_id !== scope.context.conversation.organizationId || object.purpose !== purpose || expired(object.expires_at, Number(now())) || expired(object.orphan_expires_at, Number(now()))) throw failure();
      }
      for (const object of locks.object) {
        await transition(trx, object.id, "verified", "bound", { bound_message_id: messageId });
        await trx.insertInto("message_attachments").values({ message_id: messageId, object_id: object.id, purpose, sort_order: objectIds.indexOf(object.id) }).execute();
      }
    },
  });
}
