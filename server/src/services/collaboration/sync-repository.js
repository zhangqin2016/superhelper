import { sql } from "kysely";
import { identityFacetsAvailable, withIdentityFields } from "./identity-fields.js";

export const BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION = 200;
export const BOOTSTRAP_HISTORY_TOTAL_LIMIT = 500;

// Snapshot reads use the same access matrix as read authorization, without
// adding write locks to bootstrap's REPEATABLE READ READ ONLY transaction.
function readableConversations(trx, userId) {
  return trx.selectFrom("conversations as conversation")
    .leftJoin("conversation_members as member", (join) => join.onRef("member.conversation_id", "=", "conversation.id").on("member.user_id", "=", userId).on("member.status", "=", "active"))
    .leftJoin("organizations as organization", "organization.id", "conversation.organization_id")
    .leftJoin("organization_members as team_member", (join) => join.onRef("team_member.organization_id", "=", "conversation.organization_id").on("team_member.user_id", "=", userId))
    .where("conversation.status", "=", "active")
    .where((eb) => eb.or([
      eb.and([eb("conversation.scope_type", "=", "personal"), eb("conversation.kind", "in", ["direct", "group"]), eb("member.status", "=", "active")]),
      eb.and([eb("conversation.scope_type", "=", "organization"), eb("organization.status", "=", "active"), eb("team_member.status", "=", "active"), eb.or([
        eb.and([eb("conversation.kind", "=", "channel"), eb("conversation.visibility", "=", "public")]),
        eb.and([eb("member.status", "=", "active"), eb.or([eb("conversation.kind", "=", "direct"), eb.and([eb("conversation.kind", "=", "channel"), eb("conversation.visibility", "=", "private")])])]),
      ])]),
    ]));
}

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
    async listBootstrapFriendRequests(trx, userId) {
      return trx.selectFrom("friend_requests").select(["id", "sender_user_id", "receiver_user_id", "status"])
        .where("status", "=", "pending").where((eb) => eb.or([eb("sender_user_id", "=", userId), eb("receiver_user_id", "=", userId)]))
        .orderBy("id", "asc").execute();
    },
    async listBootstrapBlocks(trx, userId) {
      return trx.selectFrom("user_blocks").select(["blocker_user_id", "blocked_user_id"])
        .where("blocker_user_id", "=", userId).orderBy("blocked_user_id", "asc").execute();
    },
    async listBootstrapTeams(trx, userId) {
      return trx.selectFrom("organization_members as member").innerJoin("organizations as organization", "organization.id", "member.organization_id")
        .select(["organization.id", "organization.name", "organization.status", "member.role", "member.joined_at"])
        .where("member.user_id", "=", userId).where("member.status", "=", "active")
        .where("organization.status", "=", "active")
        .orderBy("organization.id", "asc").execute();
    },
    async listBootstrapTeamMembers(trx, userId) {
      const facets = await identityFacetsAvailable(trx);
      let query = trx.selectFrom("organization_members as viewer")
        .innerJoin("organizations as organization", "organization.id", "viewer.organization_id")
        .innerJoin("organization_members as member", "member.organization_id", "viewer.organization_id")
        .leftJoin("user_profiles as profile", "profile.user_id", "member.user_id")
        .select(["member.organization_id", "member.user_id", "member.role", "profile.lily_id", "profile.display_name", "profile.avatar_object_id"]);
      // Login + masked phone ride along only where migration 044 has landed.
      if (facets) query = query.leftJoin("users as identity", "identity.id", "member.user_id").select(["identity.login_name", "identity.phone_e164"]);
      const rows = await query
        .where("viewer.user_id", "=", userId).where("viewer.status", "=", "active")
        .where("organization.status", "=", "active").where("member.status", "=", "active")
        .orderBy("member.organization_id", "asc").orderBy("member.user_id", "asc").execute();
      return rows.map(withIdentityFields);
    },
    async listBootstrapConversations(trx, userId, conversationId) {
      const rows = await readableConversations(trx, userId)
        .leftJoinLateral(sql`(select count(*) as unread_count,
          count(*) filter (where coalesce(creation.payload -> 'mentionUserIds', '[]'::jsonb) @> ${JSON.stringify([userId])}::jsonb) as mention_count
          from messages as activity_message
          join collaboration_events as creation on creation.id = activity_message.event_id
          where activity_message.conversation_id = conversation.id
            and activity_message.sender_user_id <> ${userId}
            and activity_message.create_seq > greatest(coalesce(member.last_read_seq, 0),
              case when conversation.visibility = 'public' then 0 else coalesce(member.joined_seq, 0) end)
        )`.as("activity"), (join) => join.onTrue())
        .select([
          "conversation.id", "conversation.scope_type", "conversation.organization_id", "conversation.kind", "conversation.visibility", "conversation.title", "conversation.status",
          "conversation.next_seq", sql`coalesce(member.role, team_member.role, 'member')`.as("role"),
          sql`coalesce(member.last_read_seq, 0)`.as("last_read_seq"), sql`coalesce(member.notification_level, 'all')`.as("notification_level"),
          sql`case when conversation.visibility = 'public' then 0 else coalesce(member.joined_seq, 0) end`.as("joined_seq"),
          sql`conversation.next_seq - 1`.as("projectionSeq"), "activity.unread_count as unreadCount", "activity.mention_count as mentionCount",
        ])
        .$if(Boolean(conversationId), (query) => query.where("conversation.id", "=", conversationId))
        .orderBy("conversation.id", "asc").execute();
      return rows.map((row) => {
        const stats = { projectionSeq: Number(row.projectionSeq), lastReadSeq: Number(row.last_read_seq), unreadCount: Number(row.unreadCount), mentionCount: Number(row.mentionCount) };
        if (Object.values(stats).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid collaboration activity projection");
        return { ...row, ...stats };
      });
    },
    async listBootstrapConversationMembers(trx, conversationIds) {
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) return [];
      return trx.selectFrom("conversation_members as member").innerJoin("conversations as conversation", "conversation.id", "member.conversation_id")
        .leftJoin("organization_members as team_member", (join) => join.onRef("team_member.organization_id", "=", "conversation.organization_id").onRef("team_member.user_id", "=", "member.user_id"))
        .selectAll("member").where("member.conversation_id", "in", conversationIds).where("member.status", "=", "active")
        .where((eb) => eb.or([eb("conversation.scope_type", "=", "personal"), eb("team_member.status", "=", "active")]))
        .orderBy("member.conversation_id", "asc").orderBy("member.user_id", "asc").execute();
    },
    async listBootstrapProfiles(trx, userIds) {
      if (!Array.isArray(userIds) || userIds.length === 0) return [];
      const facets = await identityFacetsAvailable(trx);
      let query = trx.selectFrom("user_profiles")
        .select(["user_profiles.user_id", "user_profiles.lily_id", "user_profiles.display_name", "user_profiles.avatar_object_id"]);
      if (facets) query = query.leftJoin("users as identity", "identity.id", "user_profiles.user_id").select(["identity.login_name", "identity.phone_e164"]);
      const rows = await query.where("user_profiles.user_id", "in", userIds).orderBy("user_profiles.user_id", "asc").execute();
      return rows.map(withIdentityFields);
    },
    async listBootstrapHistory(trx, userId, conversationIds, perConversationLimit) {
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) return [];
      const limit = Math.min(Math.max(1, Number(perConversationLimit) || BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION), BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION);
      const readable = readableConversations(trx, userId).select(["conversation.id", sql`case when conversation.visibility = 'public' then 0 else coalesce(member.joined_seq, 0) end`.as("joined_seq")]).where("conversation.id", "in", conversationIds).as("readable");
      const rankedHistory = trx.selectFrom("messages as message")
        .innerJoin(readable, "readable.id", "message.conversation_id")
        .select([
        "message.id", "message.conversation_id", "message.create_seq", "message.sender_user_id", "message.kind", "message.body_ciphertext", "message.body_key_version",
        "message.revision", "message.reply_to_message_id", "message.edited_at", "message.revoked_at", "message.created_at",
        sql`row_number() over (partition by message.conversation_id order by message.create_seq desc)`.as("history_rank"),
      ]).where("message.conversation_id", "in", conversationIds)
        .whereRef("message.create_seq", ">=", "readable.joined_seq").as("ranked_history");
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
