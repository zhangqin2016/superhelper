import assert from "node:assert/strict";
import crypto from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.log("collaboration sync integration: skipped (DATABASE_URL is not configured)");
  process.exit(0);
}

const [{ default: pg }, { Kysely, PostgresDialect, sql }, { createCollaborationSyncService, STALE_DEVICE_AFTER_MS }] = await Promise.all([
  import("pg"), import("kysely"), import("../src/services/collaboration/sync-service.js"),
]);

const schema = `collab_sync_it_${crypto.randomUUID().replaceAll("-", "")}`;
const schemaOption = `-c search_path=${schema}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const writer = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: schemaOption });
const servicePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: schemaOption });
const db = new Kysely({ dialect: new PostgresDialect({ pool: servicePool }) });

const userId = "user-1";
const conversationId = "conversation-1";
const secondConversationId = "conversation-2";
const fastDeviceId = "device-fast";
const slowDeviceId = "device-slow";
const staleDeviceId = "device-stale";
const newDeviceId = "device-new";
const now = new Date();

async function executeSchema() {
  await admin.query(`create schema ${schema}`);
  await writer.query(`
    create table users (id text primary key);
    create table devices (id text primary key);
    create table user_devices (user_id text not null, device_id text not null, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), status text not null default 'active', primary key (user_id, device_id));
    create table user_profiles (user_id text primary key, lily_id text not null, display_name text not null default '', avatar_object_id text, discoverability text);
    create table friendships (user_low_id text, user_high_id text, status text);
    create table friend_requests (id text, sender_user_id text, receiver_user_id text, status text);
    create table user_blocks (blocker_user_id text, blocked_user_id text);
    create table organizations (id text primary key, name text, status text);
    create table organization_members (organization_id text, user_id text, role text, status text, joined_at timestamptz default now());
    create table conversations (id text primary key, scope_type text, organization_id text, kind text, title text, status text, next_seq bigint, visibility text);
    create table conversation_members (conversation_id text, user_id text, role text, status text, last_read_seq bigint, notification_level text, joined_seq bigint);
    create table user_sync_state (user_id text primary key, next_cursor bigint not null, compacted_before_cursor bigint not null default 0, updated_at timestamptz default now());
    create table device_sync_state (user_id text, device_id text, last_acked_cursor bigint not null default 0, last_seen_at timestamptz not null default now(), requires_full_resync boolean not null default false, primary key (user_id, device_id));
    create table collaboration_events (id text primary key, conversation_id text not null, seq bigint not null, type text not null, actor_user_id text not null, actor_device_id text not null, client_command_id text not null, payload jsonb not null default '{}', created_at timestamptz not null default now());
    create table user_sync_events (user_id text not null, cursor bigint not null, event_id text not null, conversation_id text not null, created_at timestamptz not null default now(), primary key (user_id, cursor));
    create table messages (id text primary key, conversation_id text not null, create_seq bigint not null, sender_user_id text not null, kind text not null, body_ciphertext bytea, body_key_version integer, revision integer not null default 1, reply_to_message_id text, edited_at timestamptz, revoked_at timestamptz, created_at timestamptz not null default now());
    create table collaboration_bootstrap_completions (token_hash text primary key, user_id text not null, device_id text not null, watermark bigint not null, snapshot_schema_version integer not null default 1, issued_at timestamptz not null default now(), expires_at timestamptz not null, consumed_at timestamptz);
  `);
  await writer.query("insert into users values ($1)", [userId]);
  for (const deviceId of [fastDeviceId, slowDeviceId, staleDeviceId, newDeviceId]) {
    await writer.query("insert into devices values ($1)", [deviceId]);
    await writer.query("insert into user_devices (user_id, device_id, status) values ($1, $2, 'active')", [userId, deviceId]);
  }
  await writer.query("insert into user_profiles (user_id, lily_id, display_name, discoverability) values ($1, 'alice', 'Alice', 'contacts')", [userId]);
  await writer.query("insert into conversations values ($1, 'personal', null, 'direct', '', 'active', 7, null)", [conversationId]);
  await writer.query("insert into conversations values ($1, 'personal', null, 'group', 'Second', 'active', 1, null)", [secondConversationId]);
  await writer.query("insert into conversation_members values ($1, $2, 'member', 'active', 0, 'all', 2)", [conversationId, userId]);
  await writer.query("insert into conversation_members values ($1, $2, 'member', 'active', 0, 'all', 0)", [secondConversationId, userId]);
  await writer.query("insert into collaboration_events values ('evt-1', $1, 1, 'message.created', $2, $3, 'cmd-1', '{\"messageId\":\"message-1\"}', now())", [conversationId, userId, fastDeviceId]);
  await writer.query("insert into user_sync_events values ($1, 1, 'evt-1', $2, now())", [userId, conversationId]);
  await writer.query("insert into user_sync_state (user_id, next_cursor, compacted_before_cursor) values ($1, 2, 0)", [userId]);
  await writer.query("insert into device_sync_state values ($1, $2, 1, now(), false)", [userId, fastDeviceId]);
  await writer.query("insert into device_sync_state values ($1, $2, 1, now(), false)", [userId, slowDeviceId]);
  await writer.query("insert into device_sync_state values ($1, $2, 0, $3, false)", [userId, staleDeviceId, new Date(now.getTime() - STALE_DEVICE_AFTER_MS - 1)]);
  for (let sequence = 1; sequence <= 201; sequence += 1) {
    await writer.query("insert into messages (id, conversation_id, create_seq, sender_user_id, kind, revision) values ($1, $2, $3, $4, 'text', 1)", [`message-1-${sequence}`, conversationId, sequence, userId]);
  }
  await writer.query("insert into messages (id, conversation_id, create_seq, sender_user_id, kind, revision) values ('message-2', $1, 1, $2, 'text', 1)", [secondConversationId, userId]);
}

let nextInjectedCursor = 2;
const injectedBoundaries = [];
async function injectAfterBootstrapBoundary(boundary) {
  const cursor = nextInjectedCursor;
  nextInjectedCursor += 1;
  injectedBoundaries.push(boundary);
  await writer.query(
    "insert into collaboration_events values ($1, $2, $3, 'message.created', $4, $5, $6, $7::jsonb, now())",
    [`evt-${cursor}`, conversationId, cursor, userId, fastDeviceId, `cmd-${cursor}`, JSON.stringify({ messageId: `message-${cursor}`, boundary })],
  );
  await writer.query("insert into user_sync_events values ($1, $2, $3, $4, now())", [userId, cursor, `evt-${cursor}`, conversationId]);
  await writer.query("update user_sync_state set next_cursor = $1 where user_id = $2", [cursor + 1, userId]);
}

const bootstrapRepository = {
  async withReadSnapshot(callback) {
    return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      return callback(trx);
    });
  },
  async getDeviceState(trx, id, deviceId) {
    return trx.selectFrom("user_devices as ud").leftJoin("device_sync_state as ds", (join) => join.onRef("ud.user_id", "=", "ds.user_id").onRef("ud.device_id", "=", "ds.device_id"))
      .select(["ud.user_id", "ud.device_id", "ud.status as device_status", "ds.device_id as sync_device_id", "ds.last_acked_cursor", "ds.requires_full_resync", "ds.last_seen_at"])
      .where("ud.user_id", "=", id).where("ud.device_id", "=", deviceId).executeTakeFirst();
  },
  async getBootstrapProfile(trx, id) {
    const profile = await trx.selectFrom("user_profiles").selectAll().where("user_id", "=", id).executeTakeFirst();
    await injectAfterBootstrapBoundary("profile");
    return profile;
  },
  async listBootstrapRelationships(trx, id) {
    const relationships = await trx.selectFrom("friendships").selectAll().where("status", "=", "active")
      .where((eb) => eb.or([eb("user_low_id", "=", id), eb("user_high_id", "=", id)])).execute();
    await injectAfterBootstrapBoundary("relationships");
    return relationships;
  },
  async listBootstrapTeams(trx, id) {
    const teams = await trx.selectFrom("organization_members as member").innerJoin("organizations as organization", "organization.id", "member.organization_id")
      .select(["organization.id", "organization.name", "organization.status", "member.role", "member.joined_at"])
      .where("member.user_id", "=", id).where("member.status", "=", "active").execute();
    await injectAfterBootstrapBoundary("teams");
    return teams;
  },
  async listBootstrapConversations(trx, id) {
    const conversations = await trx.selectFrom("conversation_members as member").innerJoin("conversations as conversation", "conversation.id", "member.conversation_id")
      .select(["conversation.id", "conversation.scope_type", "conversation.organization_id", "conversation.kind", "conversation.title", "conversation.status", "conversation.next_seq", "member.role", "member.last_read_seq", "member.notification_level", "member.joined_seq"])
      .where("member.user_id", "=", id).where("member.status", "=", "active").where("conversation.status", "=", "active").execute();
    await injectAfterBootstrapBoundary("conversations");
    return conversations;
  },
  async listBootstrapConversationMembers(trx, conversationIds) {
    return conversationIds.length === 0 ? [] : trx.selectFrom("conversation_members").selectAll().where("conversation_id", "in", conversationIds).where("status", "=", "active").execute();
  },
  async listBootstrapProfiles(trx, userIds) {
    return userIds.length === 0 ? [] : trx.selectFrom("user_profiles").selectAll().where("user_id", "in", userIds).execute();
  },
  async listBootstrapHistory(trx, _userId, conversationIds) {
    return conversationIds.length === 0 ? [] : trx.selectFrom("messages").selectAll().where("conversation_id", "in", conversationIds).execute();
  },
  async getSyncState(trx, id) {
    const state = await trx.selectFrom("user_sync_state").selectAll().where("user_id", "=", id).executeTakeFirst();
    await injectAfterBootstrapBoundary("watermark");
    return state;
  },
  async issueBootstrapCompletion(_trx, { watermark }) { return { watermark }; },
};

try {
  await executeSchema();
  const bootstrapService = createCollaborationSyncService({ repository: bootstrapRepository });
  const bootstrap = await bootstrapService.bootstrapCollaboration({ userId, deviceId: fastDeviceId });
  assert.equal(bootstrap.watermark, 1, "the repeatable-read bootstrap snapshot must exclude writes committed between every one of its queries");
  assert.deepEqual(injectedBoundaries, ["profile", "relationships", "teams", "conversations", "watermark"]);

  const service = createCollaborationSyncService({ db, now: () => now });
  const incremental = await service.syncAfterCursor({ userId, deviceId: fastDeviceId, afterCursor: bootstrap.watermark });
  assert.deepEqual(incremental.events.map((event) => event.cursor), [2, 3, 4, 5, 6], "the post-watermark durable sync contains every boundary write without a cursor gap");
  assert.deepEqual(incremental.events.map((event) => event.payload.boundary), injectedBoundaries, "every write racing a bootstrap boundary is available to durable incremental sync");

  const blockedByNewDevice = await service.compactUserSync({ userId, retentionFloorCursor: 6 });
  assert.equal(blockedByNewDevice.compactedBeforeCursor, 0, "an active device without any ACK blocks compaction until it bootstraps");
  const newDeviceBootstrap = await service.bootstrapCollaboration({ userId, deviceId: newDeviceId });
  assert.equal(newDeviceBootstrap.watermark, 6);
  assert.equal(newDeviceBootstrap.history.filter((message) => message.conversation_id === conversationId).length, 200, "a busy conversation is capped to controlled bootstrap history");
  assert.equal(newDeviceBootstrap.history.some((message) => message.id === "message-1-1"), false, "a member who joined at sequence 2 cannot hydrate history from before joining");
  assert.equal(newDeviceBootstrap.history.some((message) => message.id === "message-2"), true, "a busy conversation cannot starve another conversation's bootstrap history");
  assert.equal(newDeviceBootstrap.historyHydration.historyComplete, false, "the controlled bootstrap window is never represented as a full archive");
  assert.deepEqual(newDeviceBootstrap.historyHydration.continuationRequiredConversationIds, [conversationId, secondConversationId], "every bootstrap conversation remains eligible for authorized history continuation");
  await service.ackDeviceCursor({ userId, deviceId: newDeviceId, cursor: 6, bootstrapCompletionToken: newDeviceBootstrap.bootstrapCompletionToken });
  await service.ackDeviceCursor({ userId, deviceId: fastDeviceId, cursor: 6 });
  await service.ackDeviceCursor({ userId, deviceId: slowDeviceId, cursor: 1 });
  const compacted = await service.compactUserSync({ userId, retentionFloorCursor: 2 });
  assert.equal(compacted.compactedBeforeCursor, 1, "the slow active device keeps its incremental cursor window");
  assert.deepEqual(compacted.staleDeviceIds, [staleDeviceId]);
  const stale = await service.syncAfterCursor({ userId, deviceId: staleDeviceId, afterCursor: 0 });
  assert.equal(stale.code, "FULL_RESYNC_REQUIRED", "a stale device is explicitly forced through bootstrap");
  const slowIncremental = await service.syncAfterCursor({ userId, deviceId: slowDeviceId, afterCursor: 1 });
  assert.deepEqual(slowIncremental.events.map((event) => event.cursor), [2, 3, 4, 5, 6], "the slow active device remains eligible for every incremental event after compaction");
  console.log("collaboration sync integration: ok");
} finally {
  await db.destroy();
  await writer.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
