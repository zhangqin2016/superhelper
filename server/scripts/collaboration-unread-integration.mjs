import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import pg from "pg";
import Fastify from "fastify";

if (!process.env.DATABASE_URL) {
  console.log("collaboration unread integration: skipped (DATABASE_URL is not configured)");
  process.exit(0);
}
const schema = `collab_unread_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
Object.assign(process.env, {
  DATABASE_URL: scoped.href, SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  COLLABORATION_ENABLED: "true", COLLABORATION_KILL_SWITCH: "false",
  COLLABORATION_ROLLOUT_ORGANIZATIONS: "", COLLAB_MESSAGE_KEK: crypto.randomBytes(32).toString("hex"), COLLAB_MESSAGE_KEK_VERSION: "v1",
});
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { createAccessToken }, { stableStringify, sha256 }, { installDocOnlyCompilers }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/services/account-auth.js"),
  import("../src/services/security.js"), import("../src/openapi.js"),
]);
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring.js");
const { createCollaborationClient } = require("../../src/main/collaboration/client.js");
const { createCollaborationService } = require("../../src/main/collaboration/service.js");
const app = Fastify({ logger: false });
installDocOnlyCompilers(app);
const devices = new Map();
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-unread-pg-"));
const storeOptions = {
  dbPath: path.join(localDir, "cache.db"), accountId: "viewer",
  keyring: new LocalCollaborationKeyring({ filePath: path.join(localDir, "keys"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } }),
};
let local, desktop;
async function request(deviceId, endpoint, fields = {}) {
  const identity = devices.get(deviceId), pathname = `/api/collaboration/v1/${endpoint}`;
  const body = { deviceId, ...fields }, timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
  const bodyHash = sha256(stableStringify(body));
  const signature = crypto.sign(null, Buffer.from(stableStringify({ method: "POST", pathname, timestamp, nonce, bodyHash })), identity.key.privateKey).toString("base64url");
  const response = await app.inject({ method: "POST", url: pathname, payload: body, headers: {
    authorization: `Bearer ${createAccessToken({ userId: identity.userId, deviceId, sessionId: `session-${deviceId}` })}`,
    "x-lily-device-id": deviceId, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce,
    "x-lily-body-sha256": bodyHash, "x-lily-signature": signature,
  } });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  return response.json();
}
function counts(conversation) {
  return { projectionSeq: conversation.projectionSeq, lastReadSeq: conversation.lastReadSeq,
    unreadCount: conversation.unreadCount, mentionCount: conversation.mentionCount };
}
const projection = async () => (await request("viewer-one", "conversations/get", { conversationId: "group" })).result.conversation;
const message = (deviceId, fields) => request(deviceId, "messages", { conversationId: "group", clientCommandId: crypto.randomUUID(), ...fields });

try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key);
    create table devices(id text primary key);
    create table user_devices(user_id text references users(id),device_id text references devices(id),status text default 'active',primary key(user_id,device_id));
    create table user_profiles(user_id text primary key,lily_id text,display_name text,avatar_object_id text,discoverability text);
    create table organizations(id text primary key,name text,status text);
    create table organization_members(organization_id text,user_id text,role text,status text,joined_at timestamptz default now(),primary key(organization_id,user_id));
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
    insert into users values('viewer'),('writer');
    insert into user_profiles values('viewer','viewer','Viewer',null,'contacts'),('writer','writer','Writer',null,'contacts');
  `);
  for (const migration of ["033_collaboration_core.sql", "035_collaboration_bootstrap_completion.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "040_collaboration_trusted_actors.sql", "041_collaboration_reply_snapshots.sql"]) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  for (const [deviceId, userId] of [["viewer-one", "viewer"], ["viewer-two", "viewer"], ["writer-one", "writer"]]) {
    const key = crypto.generateKeyPairSync("ed25519"); devices.set(deviceId, { userId, key });
    await pool.query("insert into devices values($1)", [deviceId]);
    await pool.query("insert into user_devices(user_id,device_id) values($1,$2)", [userId, deviceId]);
    await pool.query("insert into user_sessions values($1,$2,$3,null,now()+interval '1 hour')", [`session-${deviceId}`, userId, deviceId]);
    await pool.query("insert into device_public_keys values($1,$2)", [deviceId, key.publicKey.export({ type: "spki", format: "pem" })]);
  }
  // Bulk history is fixture data, constrained by the actual shipped schema.
  // Every mutation/read below uses the signed HTTP and transactional writer.
  await pool.query(`
    insert into conversations(id,scope_type,kind,created_by,next_seq) values('group','personal','group','writer',601);
    insert into conversation_members(conversation_id,user_id,role) values('group','viewer','member'),('group','writer','owner');
    insert into collaboration_events(id,conversation_id,seq,type,actor_user_id,actor_device_id,client_command_id,payload)
      select 'event-'||g,'group',g,'message.created',case when g<=550 then 'writer' else 'viewer' end,
        case when g<=550 then 'writer-one' else 'viewer-one' end,'seed-'||g,
        jsonb_build_object('messageId','message-'||g,'mentionUserIds',case when g%5=0 then '["viewer"]'::jsonb else '[]'::jsonb end)
      from generate_series(1,600) g;
    insert into messages(id,event_id,conversation_id,create_seq,sender_user_id)
      select 'message-'||g,'event-'||g,'group',g,case when g<=550 then 'writer' else 'viewer' end from generate_series(1,600) g;
  `);
  registerCollaborationRoutes(app, { database: db });
  assert.deepEqual(counts(await projection()), { projectionSeq: 600, lastReadSeq: 0, unreadCount: 550, mentionCount: 110 },
    "all authorized messages, not a sequence difference or a recent 200-row window, determine unread and mentions");
  const snapshot = await request("viewer-one", "bootstrap");
  assert.equal(snapshot.history.length, 200, "bootstrap still bounds cached message history");
  assert.deepEqual(counts(snapshot.conversations[0]), { projectionSeq: 600, lastReadSeq: 0, unreadCount: 550, mentionCount: 110 });
  await request("viewer-one", "ack", { clientCommandId: "initial-bootstrap-ack", cursor: snapshot.watermark, bootstrapCompletionToken: snapshot.bootstrapCompletionToken });
  local = new CollaborationStore(storeOptions);
  local.replaceProjectionFromBootstrap(snapshot);
  assert.equal(local.listMessages({ conversationId: "group" }).length, 200);
  assert.deepEqual(counts(local.getConversation({ conversationId: "group" })), counts(snapshot.conversations[0]));
  local.close(); local = new CollaborationStore(storeOptions);
  assert.deepEqual(counts(local.getConversation({ conversationId: "group" })), counts(snapshot.conversations[0]), "exact aggregate survives a desktop restart");

  await message("writer-one", { action: "edit", messageId: "message-5", expectedRevision: 1, bodyText: "edited" });
  await message("writer-one", { action: "revoke", messageId: "message-5", expectedRevision: 2 });
  await message("viewer-one", { action: "send", bodyText: "own message", mentionUserIds: ["viewer"] });
  assert.deepEqual(counts(await projection()), { projectionSeq: 603, lastReadSeq: 0, unreadCount: 550, mentionCount: 110 },
    "edit/revoke do not add activity and own mentions never inflate unread");
  await message("writer-one", { action: "send", bodyText: "new incoming mention", mentionUserIds: ["viewer"] });
  assert.deepEqual(counts(await projection()), { projectionSeq: 604, lastReadSeq: 0, unreadCount: 551, mentionCount: 111 });
  const readIntent = { action: "read", seq: 300, clientCommandId: "second-device-read-300" };
  const read = await message("viewer-two", readIntent);
  assert.equal(read.result.lastReadSeq, 300);
  assert.deepEqual((await message("viewer-two", readIntent)).result, read.result, "a dropped read ACK is replayed with its original command identity");
  assert.deepEqual(counts(await projection()), { projectionSeq: 605, lastReadSeq: 300, unreadCount: 251, mentionCount: 51 },
    "another device's partial read changes exact counts without needing the missing old local history");
  await message("viewer-one", { action: "read", seq: 2 });
  assert.deepEqual(counts(await projection()), { projectionSeq: 606, lastReadSeq: 300, unreadCount: 251, mentionCount: 51 }, "older reads cannot regress the shared watermark");
  let acknowledged = 0;
  let expectedAckCounts = { projectionSeq: 606, lastReadSeq: 300, unreadCount: 251, mentionCount: 51 };
  let expectedAckMentions = null;
  const client = createCollaborationClient({
    accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "fixture-adapter" }) },
    signDeviceRequest: async () => ({}),
    request: async ({ path: route, body }) => {
      const endpoint = route.split("/api/collaboration/v1/")[1];
      if (endpoint === "ack") {
        assert.deepEqual(counts(local.getConversation({ conversationId: "group" })),
          expectedAckCounts,
          "the desktop must persist the exact authorized read projection before cursor ACK");
        if (expectedAckMentions) {
          for (const [messageId, ids] of expectedAckMentions) assert.deepEqual(local.getMessage({ conversationId: "group", messageId })?.mentionUserIds, ids,
            "bootstrap cannot ACK before authorized reminder identities are persisted");
        }
        acknowledged += 1;
      }
      // The adapter retains the real bearer session + Ed25519 signature above.
      return { ok: true, status: 200, json: await request("viewer-one", endpoint, body) };
    },
  });
  desktop = createCollaborationService({ openStore: () => ({ ok: true, store: local }), client, deviceId: "viewer-one", realtimeOptions: { syncArgs: { deviceId: "viewer-one" } } });
  await desktop.realtime.notifyAvailable();
  assert.equal(acknowledged, 1, "second-device read events reach the desktop's durable hydration and ACK chain");
  await desktop.realtime.notifyAvailable();
  assert.equal(acknowledged, 2, "repeated sync does not double-count a fresh projection");
  await pool.query(`
    insert into organizations values('team','Team','active');
    insert into organization_members(organization_id,user_id,role,status) values('team','writer','owner','active'),('team','viewer','member','active');
    insert into conversations(id,scope_type,organization_id,kind,visibility,created_by,next_seq)
      values('public','organization','team','channel','public','writer',7),('private','organization','team','channel','private','writer',7);
    insert into conversation_members(conversation_id,user_id,role,joined_seq)
      values('public','writer','owner',0),('private','writer','owner',0),('private','viewer','member',4);
    insert into collaboration_events(id,conversation_id,seq,type,actor_user_id,actor_device_id,client_command_id,payload)
      select c.id||'-event-'||g,c.id,g,'message.created','writer','writer-one',c.id||'-seed-'||g,
        jsonb_build_object('messageId',c.id||'-message-'||g,'mentionUserIds',case when g=5 then '["viewer"]'::jsonb else '[]'::jsonb end)
      from conversations c cross join generate_series(1,6) g where c.id in ('public','private') and g<>4;
    insert into messages(id,event_id,conversation_id,create_seq,sender_user_id)
      select c.id||'-message-'||g,c.id||'-event-'||g,c.id,g,'writer'
      from conversations c cross join generate_series(1,6) g where c.id in ('public','private') and g<>4;
  `);
  const channel = async (conversationId) => (await request("viewer-one", "conversations/get", { conversationId })).result.conversation;
  assert.deepEqual(counts(await channel("private")), { projectionSeq: 6, lastReadSeq: 0, unreadCount: 2, mentionCount: 1 },
    "private-channel counts must exclude pre-membership history");
  assert.deepEqual(counts(await channel("public")), { projectionSeq: 6, lastReadSeq: 0, unreadCount: 5, mentionCount: 1 },
    "an active Team member can count public history without an explicit conversation member row");

  // The plain-text composer exposes explicit reminder tags. Neither a typed
  // display name nor hostile HTML in a body may manufacture notification IDs.
  const beforeReminders = counts(await projection());
  const plain = await message("writer-one", { action: "send", bodyText: '@viewer <span data-user-id="viewer">@Viewer</span>', mentionUserIds: [] });
  const afterPlain = counts(await projection());
  assert.equal(afterPlain.mentionCount, beforeReminders.mentionCount, "body @ text/markup alone never creates a mention");
  assert.equal(afterPlain.unreadCount, beforeReminders.unreadCount + 1, "plain body still creates an ordinary unread message");
  const detail = (await request("writer-one", "conversations/get", { conversationId: "group" })).result;
  const selected = detail.mentionCandidates.items.find((item) => item.userId === "viewer");
  assert.ok(selected, "the signed authorized candidate supplies the stable reminder identity");
  const reminderIntent = { action: "send", clientCommandId: "explicit-reminder-tag", bodyText: "Please review the result", mentionUserIds: [selected.userId] };
  const tagged = await message("writer-one", reminderIntent);
  assert.deepEqual((await message("writer-one", reminderIntent)).result, tagged.result, "reminder retry uses the original committed command");
  const afterTagged = counts(await projection());
  assert.equal(afterTagged.mentionCount, afterPlain.mentionCount + 1, "explicit stable ID adds one mention without an @ name in the body");
  assert.equal(afterTagged.unreadCount, afterPlain.unreadCount + 1);
  assert.equal(afterTagged.projectionSeq, afterPlain.projectionSeq + 1, "retry adds no duplicate event");
  const reminderEvents = await pool.query("select client_command_id,payload from collaboration_events where client_command_id=$1", [reminderIntent.clientCommandId]);
  assert.equal(reminderEvents.rows.length, 1);
  assert.deepEqual(reminderEvents.rows[0].payload.mentionUserIds, ["viewer"]);
  // Raw bootstrap history is encrypted server metadata, not a ready local
  // message view. The real service owns authorized hydration before ACK.
  expectedAckCounts = afterTagged;
  expectedAckMentions = [[plain.result.message.id, []], [tagged.result.message.id, ["viewer"]]];
  await desktop.bootstrap();
  assert.equal(acknowledged, 3, "explicit reminder bootstrap completes its authorized hydration and ACK");
  assert.deepEqual(local.getMessage({ conversationId: "group", messageId: plain.result.message.id }).mentionUserIds, []);
  assert.deepEqual(local.getMessage({ conversationId: "group", messageId: tagged.result.message.id }).mentionUserIds, ["viewer"], "signed bootstrap, authorized hydration and encrypted SQLite retain explicit reminder IDs");
  console.log("collaboration unread integration: signed HTTP exact counts, bounded history, read replay and SQLite restart passed");
  console.log("collaboration mentions: plain @ text versus explicit authorized reminder IDs and replay passed");
} finally {
  if (desktop) desktop.stop(); else local?.close();
  await app.close(); await closeDb();
  await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  fs.rmSync(localDir, { recursive: true, force: true });
}
