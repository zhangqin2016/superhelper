#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.log("collaboration friends integration: skipped (DATABASE_URL is not configured)");
  process.exit(0);
}

const [{ default: pg }, { Kysely, PostgresDialect }, { createCollaborationFriendService, createKyselyFriendRepository }] = await Promise.all([
  import("pg"), import("kysely"), import("../src/services/collaboration/friends.js"),
]);
const schema = `collab_friends_it_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users (id text primary key);
    create table devices (id text primary key, user_id text not null references users(id));
    create table user_devices (user_id text not null references users(id), device_id text not null references devices(id), status text not null default 'active', primary key(user_id, device_id));
    create table user_profiles (user_id text primary key references users(id), lily_id text not null unique, lily_id_display text not null, display_name text not null default '', discoverability text not null default 'public', avatar_object_id text);
    create table friend_requests (id text primary key, sender_user_id text not null references users(id), receiver_user_id text not null references users(id), status text not null, message text, created_at timestamptz not null default now(), responded_at timestamptz);
    create unique index friend_requests_pending_pair_uk on friend_requests(sender_user_id, receiver_user_id) where status = 'pending';
    create table friendships (user_low_id text not null references users(id), user_high_id text not null references users(id), status text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key(user_low_id, user_high_id));
    create table user_blocks (blocker_user_id text not null references users(id), blocked_user_id text not null references users(id), created_at timestamptz not null default now(), primary key(blocker_user_id, blocked_user_id));
    create table conversations (id text primary key, scope_type text not null, kind text not null, title text not null default '', status text not null, direct_pair_key text, direct_user_low_id text references users(id), direct_user_high_id text references users(id), next_seq bigint not null default 1, created_by text not null references users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create unique index conversations_personal_direct_pair_uk on conversations(direct_user_low_id, direct_user_high_id) where scope_type = 'personal' and kind = 'direct' and status = 'active';
    create table conversation_members (conversation_id text not null references conversations(id), user_id text not null references users(id), role text not null default 'member', status text not null default 'active', joined_seq bigint not null default 0, last_read_seq bigint not null default 0, left_at timestamptz, primary key(conversation_id, user_id));
    create table command_receipts (actor_device_id text not null references devices(id), command_type text not null, client_command_id text not null, request_fingerprint text not null, state text not null, result_event_id text, response_code text, response_payload jsonb not null default '{}', created_at timestamptz not null default now(), completed_at timestamptz, primary key(actor_device_id, command_type, client_command_id));
    create sequence collaboration_relationship_event_seq;
    create table collaboration_events (id text primary key, conversation_id text references conversations(id), seq bigint not null, type text not null, actor_user_id text not null references users(id), actor_device_id text not null references devices(id), client_command_id text not null, payload jsonb not null default '{}', unique(conversation_id, seq));
    create table user_sync_state (user_id text primary key references users(id), next_cursor bigint not null default 1, compacted_before_cursor bigint not null default 0, updated_at timestamptz not null default now());
    create table user_sync_events (user_id text not null references users(id), cursor bigint not null, event_id text not null references collaboration_events(id), conversation_id text references conversations(id), created_at timestamptz not null default now(), primary key(user_id, cursor));
    create table collaboration_realtime_outbox (id bigserial primary key, user_id text not null references users(id), max_cursor bigint not null, state text not null default 'pending', available_at timestamptz not null default now(), attempts integer not null default 0);
  `);
  await pool.query("insert into users(id) values ('user-a'), ('user-b')");
  await pool.query("insert into devices(id, user_id) values ('device-a', 'user-a'), ('device-b', 'user-b')");
  await pool.query("insert into user_devices(user_id, device_id) values ('user-a', 'device-a'), ('user-b', 'device-b')");
  await pool.query("insert into user_profiles(user_id, lily_id, lily_id_display, display_name, discoverability) values ('user-a', 'lily-a', 'lily-a', 'A', 'public'), ('user-b', 'lily-b', 'lily-b', 'B', 'public')");
  let id = 0;
  const service = createCollaborationFriendService({ repository: createKyselyFriendRepository(db), createId: (prefix) => `${prefix}-${++id}` });
  const accountA = { userId: "user-a", deviceId: "device-a" };
  const accountB = { userId: "user-b", deviceId: "device-b" };
  const requested = await service.requestFriend({ account: accountA, clientCommandId: "request-1", lilyId: "lily-b" });
  const requestEvent = await pool.query("select payload from collaboration_events where type = 'friend.requested'");
  assert.deepEqual(requestEvent.rows[0].payload.participantUserIds, ["user-a", "user-b"]);
  assert.equal(requestEvent.rows[0].payload.profilesByUserId["user-a"].displayName, "A", "the receiver can derive the sender profile from the neutral request payload");
  const beforeConcurrentAccept = await pool.query("select (select count(*)::int from user_sync_events where user_id = 'user-a') as a_sync, (select count(*)::int from user_sync_events where user_id = 'user-b') as b_sync, (select count(*)::int from collaboration_realtime_outbox) as outbox_count");
  const accepted = await Promise.all([
    service.respondToFriendRequest({ account: accountB, clientCommandId: "accept-1", requestId: requested.requestId, accept: true }),
    service.respondToFriendRequest({ account: accountB, clientCommandId: "accept-2", requestId: requested.requestId, accept: true }),
  ]);
  assert.equal(accepted[0].status, "active");
  assert.equal(accepted[1].status, "active");
  const friendshipCount = await pool.query("select count(*)::int as count from friendships where status = 'active'");
  const directCount = await pool.query("select count(*)::int as count from conversations where scope_type = 'personal' and kind = 'direct'");
  assert.equal(friendshipCount.rows[0].count, 1, "concurrent accepts create exactly one friendship");
  assert.equal(directCount.rows[0].count, 1, "concurrent accepts create exactly one direct conversation");
  const acceptedEvents = await pool.query("select count(*)::int as count from collaboration_events where type = 'friend.accepted'");
  const afterConcurrentAccept = await pool.query("select (select count(*)::int from user_sync_events where user_id = 'user-a') as a_sync, (select count(*)::int from user_sync_events where user_id = 'user-b') as b_sync, (select count(*)::int from collaboration_realtime_outbox) as outbox_count");
  assert.equal(acceptedEvents.rows[0].count, 1, "concurrent accepts emit one immutable acceptance event");
  assert.equal(afterConcurrentAccept.rows[0].a_sync, beforeConcurrentAccept.rows[0].a_sync + 1);
  assert.equal(afterConcurrentAccept.rows[0].b_sync, beforeConcurrentAccept.rows[0].b_sync + 1);
  assert.equal(afterConcurrentAccept.rows[0].outbox_count, beforeConcurrentAccept.rows[0].outbox_count + 2);
  const originalConversationId = accepted[0].conversationId;
  await service.removeFriend({ account: accountA, clientCommandId: "remove-1", peerUserId: "user-b" });
  const readded = await service.requestFriend({ account: accountA, clientCommandId: "request-2", lilyId: "lily-b" });
  const reaccepted = await service.respondToFriendRequest({ account: accountB, clientCommandId: "accept-3", requestId: readded.requestId, accept: true });
  assert.equal(reaccepted.conversationId, originalConversationId, "re-adding a friend reuses the original direct conversation");
  const directAfterReadd = await pool.query("select count(*)::int as count from conversations where scope_type = 'personal' and kind = 'direct'");
  assert.equal(directAfterReadd.rows[0].count, 1);
  const syncAndOutbox = await pool.query("select (select count(*)::int from user_sync_events where user_id = 'user-a') as a_sync, (select count(*)::int from user_sync_events where user_id = 'user-b') as b_sync, (select count(*)::int from collaboration_realtime_outbox) as outbox_count");
  assert.ok(syncAndOutbox.rows[0].a_sync > 0 && syncAndOutbox.rows[0].b_sync > 0, "relationship transitions fan out durable cursors to both users");
  assert.ok(syncAndOutbox.rows[0].outbox_count >= 2, "each durable relationship sync cursor creates a realtime wake-up outbox row");
  await service.removeFriend({ account: accountA, clientCommandId: "remove-before-decline", peerUserId: "user-b" });
  const pendingDecline = await service.requestFriend({ account: accountB, clientCommandId: "request-decline", lilyId: "lily-a" });
  const beforeDecline = await pool.query("select (select count(*)::int from user_sync_events where user_id = 'user-a') as a_sync, (select count(*)::int from user_sync_events where user_id = 'user-b') as b_sync, (select count(*)::int from collaboration_realtime_outbox) as outbox_count");
  await service.respondToFriendRequest({ account: accountA, clientCommandId: "decline-1", requestId: pendingDecline.requestId, accept: false });
  const afterDecline = await pool.query("select (select count(*)::int from user_sync_events where user_id = 'user-a') as a_sync, (select count(*)::int from user_sync_events where user_id = 'user-b') as b_sync, (select count(*)::int from collaboration_realtime_outbox) as outbox_count");
  assert.equal(afterDecline.rows[0].a_sync, beforeDecline.rows[0].a_sync + 1, "a decline emits one relationship cursor for the receiver");
  assert.equal(afterDecline.rows[0].b_sync, beforeDecline.rows[0].b_sync + 1, "a decline emits one relationship cursor for the sender");
  assert.equal(afterDecline.rows[0].outbox_count, beforeDecline.rows[0].outbox_count + 2, "a decline emits one durable wake-up row per endpoint");
  await pool.query("update user_devices set status = 'revoked' where user_id = 'user-a' and device_id = 'device-a'");
  const beforeRevoked = await pool.query("select (select count(*)::int from collaboration_events) as events, (select count(*)::int from user_sync_events) as syncs, (select count(*)::int from collaboration_realtime_outbox) as outbox");
  await assert.rejects(() => service.blockUser({ account: accountA, clientCommandId: "revoked-block", peerUserId: "user-b" }), (error) => error?.code === "COLLAB_DEVICE_REVOKED");
  const afterRevoked = await pool.query("select (select count(*)::int from collaboration_events) as events, (select count(*)::int from user_sync_events) as syncs, (select count(*)::int from collaboration_realtime_outbox) as outbox");
  assert.deepEqual(afterRevoked.rows[0], beforeRevoked.rows[0], "a revoked device is rejected before events, sync cursors, or outbox rows are written");
  console.log("collaboration friends integration: ok");
} finally {
  await db.destroy();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
