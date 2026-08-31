import { sql } from "kysely";

export const BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION = 200;
export const BOOTSTRAP_HISTORY_TOTAL_LIMIT = 500;

export function createKyselyRepository(db) {
  if (!db || typeof db.transaction !== "function") throw new TypeError("A Kysely database is required for collaboration sync.");
  return {
    async withReadSnapshot(callback) {
      return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
        await sql`set transaction read only`.execute(trx);
        return callback(trx);
      });
    },
    async withWriteTransaction(callback) {
      return db.transaction().execute(callback);
    },
    async getSyncState(trx, userId) {
      return trx.selectFrom("user_sync_state").selectAll().where("user_id", "=", userId).executeTakeFirst();
    },
    async getDeviceState(trx, userId, deviceId) {
      return trx.selectFrom("user_devices as ud")
        .leftJoin("device_sync_state as ds", (join) => join.onRef("ds.user_id", "=", "ud.user_id").onRef("ds.device_id", "=", "ud.device_id"))
        .select(["ud.user_id", "ud.device_id", "ud.status as device_status", "ds.device_id as sync_device_id", "ds.last_acked_cursor", "ds.requires_full_resync", "ds.last_seen_at"])
        .where("ud.user_id", "=", userId).where("ud.device_id", "=", deviceId).executeTakeFirst();
    },
    async listSyncEvents(trx, userId, afterCursor, fetchLimit) {
      return trx.selectFrom("user_sync_events as use")
        .innerJoin("collaboration_events as event", "event.id", "use.event_id")
        .select([
          "use.cursor as cursor", "event.id as id", "event.conversation_id as conversation_id", "event.seq as seq",
          "event.type as type", "event.client_command_id as client_command_id", "event.actor_user_id as actor_user_id", "event.created_at as created_at", "event.payload as payload",
        ])
        .where("use.user_id", "=", userId).where("use.cursor", ">", afterCursor)
        .orderBy("use.cursor", "asc").limit(fetchLimit).execute();
    },
    async getBootstrapProfile(trx, userId) {
      return trx.selectFrom("user_profiles").selectAll().where("user_id", "=", userId).executeTakeFirst();
    },
    async listBootstrapRelationships(trx, userId) {
      return trx.selectFrom("friendships").selectAll().where("status", "=", "active")
        .where((eb) => eb.or([eb("user_low_id", "=", userId), eb("user_high_id", "=", userId)]))
        .orderBy("user_low_id", "asc").orderBy("user_high_id", "asc").execute();
    },
    async listBootstrapTeams(trx, userId) {
      return trx.selectFrom("organization_members as member").innerJoin("organizations as organization", "organization.id", "member.organization_id")
        .select(["organization.id", "organization.name", "organization.status", "member.role", "member.joined_at"])
        .where("member.user_id", "=", userId).where("member.status", "=", "active")
        .orderBy("organization.id", "asc").execute();
    },
    async listBootstrapConversations(trx, userId) {
      return trx.selectFrom("conversation_members as member").innerJoin("conversations as conversation", "conversation.id", "member.conversation_id")
        .select([
          "conversation.id", "conversation.scope_type", "conversation.organization_id", "conversation.kind", "conversation.title", "conversation.status",
          "conversation.next_seq", "member.role", "member.last_read_seq", "member.notification_level", "member.joined_seq",
        ])
        .where("member.user_id", "=", userId).where("member.status", "=", "active")
        .where("conversation.status", "=", "active").orderBy("conversation.id", "asc").execute();
    },
    async listBootstrapConversationMembers(trx, conversationIds) {
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) return [];
      return trx.selectFrom("conversation_members").selectAll().where("conversation_id", "in", conversationIds)
        .where("status", "=", "active").orderBy("conversation_id", "asc").orderBy("user_id", "asc").execute();
    },
    async listBootstrapProfiles(trx, userIds) {
      if (!Array.isArray(userIds) || userIds.length === 0) return [];
      return trx.selectFrom("user_profiles").select(["user_id", "lily_id", "display_name", "avatar_object_id", "discoverability"])
        .where("user_id", "in", userIds).orderBy("user_id", "asc").execute();
    },
    async listBootstrapHistory(trx, userId, conversationIds, perConversationLimit) {
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) return [];
      const limit = Math.min(Math.max(1, Number(perConversationLimit) || BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION), BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION);
      const rankedHistory = trx.selectFrom("messages as message")
        .innerJoin("conversation_members as member", (join) => join.onRef("member.conversation_id", "=", "message.conversation_id").on("member.user_id", "=", userId))
        .select([
        "message.id", "message.conversation_id", "message.create_seq", "message.sender_user_id", "message.kind", "message.body_ciphertext", "message.body_key_version",
        "message.revision", "message.reply_to_message_id", "message.edited_at", "message.revoked_at", "message.created_at",
        sql`row_number() over (partition by message.conversation_id order by message.create_seq desc)`.as("history_rank"),
      ]).where("message.conversation_id", "in", conversationIds).where("member.status", "=", "active")
        .whereRef("message.create_seq", ">=", "member.joined_seq").as("ranked_history");
      return trx.selectFrom(rankedHistory).selectAll().where("history_rank", "<=", limit)
        // Round-robin the newest window across conversations before the global
        // cap, so a lexically early busy conversation cannot starve all others.
        .orderBy("history_rank", "asc").orderBy("conversation_id", "asc").limit(BOOTSTRAP_HISTORY_TOTAL_LIMIT + 1).execute();
    },
    async issueBootstrapCompletion(trx, { userId, deviceId, tokenHash, watermark, expiresAt }) {
      const binding = await trx.selectFrom("user_devices").select("device_id")
        .where("user_id", "=", userId).where("device_id", "=", deviceId).where("status", "=", "active").executeTakeFirst();
      if (!binding) return null;
      await trx.insertInto("collaboration_bootstrap_completions").values({
        token_hash: tokenHash, user_id: userId, device_id: deviceId, watermark, expires_at: expiresAt,
      }).execute();
      return { watermark };
    },
    async consumeBootstrapCompletion(trx, { userId, deviceId, tokenHash, watermark }) {
      return trx.updateTable("collaboration_bootstrap_completions")
        .set({ consumed_at: sql`now()` }).where("token_hash", "=", tokenHash).where("user_id", "=", userId)
        .where("device_id", "=", deviceId).where("watermark", "=", watermark).where("consumed_at", "is", null)
        .where("expires_at", ">", sql`now()`).returning(["watermark"]).executeTakeFirst();
    },
    async acknowledgeDeviceCursor(trx, { userId, deviceId, cursor, completeFullResync }) {
      const binding = await trx.selectFrom("user_devices").select("device_id")
        .where("user_id", "=", userId).where("device_id", "=", deviceId).where("status", "=", "active").executeTakeFirst();
      if (!binding) return null;
      await trx.insertInto("device_sync_state").values({ user_id: userId, device_id: deviceId })
        .onConflict((conflict) => conflict.columns(["user_id", "device_id"]).doNothing()).execute();
      return trx.updateTable("device_sync_state")
        .set({
          last_acked_cursor: sql`greatest(last_acked_cursor, ${cursor})`,
          last_seen_at: sql`now()`,
          ...(completeFullResync ? { requires_full_resync: false } : {}),
        })
        .where("user_id", "=", userId).where("device_id", "=", deviceId).returningAll().executeTakeFirst();
    },
    async listDeviceStates(trx, userId) {
      return trx.selectFrom("user_devices as ud")
        .leftJoin("device_sync_state as ds", (join) => join.onRef("ud.user_id", "=", "ds.user_id").onRef("ud.device_id", "=", "ds.device_id"))
        .select([
          "ud.user_id", "ud.device_id", "ud.status as device_status", "ud.last_seen_at as bound_last_seen_at", "ds.last_acked_cursor", "ds.last_seen_at", "ds.requires_full_resync",
        ]).where("ud.user_id", "=", userId).where("ud.status", "=", "active")
        .orderBy("ud.device_id", "asc").forUpdate("ud").execute();
    },
    async markDevicesRequireFullResync(trx, userId, deviceIds) {
      if (!Array.isArray(deviceIds) || deviceIds.length === 0) return;
      await trx.updateTable("device_sync_state").set({ requires_full_resync: true })
        .where("user_id", "=", userId).where("device_id", "in", deviceIds).execute();
    },
    async advanceCompactedBeforeCursor(trx, userId, cursor) {
      await trx.insertInto("user_sync_state").values({ user_id: userId, next_cursor: 1 })
        .onConflict((conflict) => conflict.column("user_id").doNothing()).execute();
      await trx.deleteFrom("user_sync_events").where("user_id", "=", userId).where("cursor", "<=", cursor).execute();
      return trx.updateTable("user_sync_state")
        .set({ compacted_before_cursor: sql`greatest(compacted_before_cursor, ${cursor})`, updated_at: sql`now()` })
        .where("user_id", "=", userId).returningAll().executeTakeFirst();
    },
  };
}
