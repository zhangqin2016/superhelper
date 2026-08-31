import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import Fastify from "fastify";

if (!process.env.DATABASE_URL) { console.log("collaboration receipt integration: skipped (DATABASE_URL is not configured)"); process.exit(0); }
const connectionString = process.env.DATABASE_URL;
const schema = `collab_receipt_it_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const scoped = new URL(connectionString); scoped.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = scoped.href;
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.COLLABORATION_ENABLED = "true";
process.env.COLLABORATION_KILL_SWITCH = "false";
process.env.COLLABORATION_ROLLOUT_ORGANIZATIONS = "";
process.env.COLLAB_MESSAGE_KEK = crypto.randomBytes(32).toString("hex");
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { createAccessToken }, { stableStringify, sha256 }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/services/account-auth.js"), import("../src/services/security.js"),
]);
const app = Fastify({ logger: false });
const { createLockedMessageAuthorizer } = await import("../src/services/collaboration/message-repository.js");
const authorize = createLockedMessageAuthorizer();
let historyBarrier = null;
const key = crypto.generateKeyPairSync("ed25519");
const pathname = "/api/collaboration/v1/command-receipt";
const accountToken = (userId, deviceId = "device") => createAccessToken({ userId, deviceId, sessionId: `session-${userId}` });
async function receipt(userId, changes = {}, { validSignature = true, token = accountToken(userId), route = pathname } = {}) {
  const body = { deviceId: "device", clientCommandId: "send", commandType: "message.create", expectedConversationId: "conv", ...changes };
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
  const signature = crypto.sign(null, Buffer.from(stableStringify({ method: "POST", pathname: route, timestamp, nonce, bodyHash })), key.privateKey).toString("base64url");
  const result = await app.inject({ method: "POST", url: route, payload: body, headers: {
    authorization: `Bearer ${token}`, "x-lily-device-id": body.deviceId, "x-lily-timestamp": timestamp,
    "x-lily-nonce": nonce, "x-lily-body-sha256": bodyHash, "x-lily-signature": validSignature ? signature : "invalid",
  } });
  return { status: result.statusCode, body: result.json() };
}
try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key);
    create table devices(id text primary key);
    create table organizations(id text primary key);
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
    create table user_devices(user_id text,device_id text,status text,primary key(user_id,device_id));
    insert into users values('alice'),('bob');
    insert into devices values('device');
    insert into user_sessions values('session-alice','alice','device',null,now()+interval '1 hour'),('session-bob','bob','device',null,now()+interval '1 hour');
    insert into user_devices values('alice','device','active'),('bob','device','active');
  `);
  for (const migration of ["033_collaboration_core.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "040_collaboration_trusted_actors.sql"]) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    insert into conversations(id,scope_type,kind,direct_pair_key,direct_user_low_id,direct_user_high_id,created_by,next_seq)
      values('conv','personal','direct','alice:bob','alice','bob','alice',6);
    insert into conversation_members(conversation_id,user_id) values('conv','alice'),('conv','bob');
    insert into friendships(user_low_id,user_high_id) values('alice','bob');
    insert into collaboration_events(id,conversation_id,actor_user_id,actor_device_id,payload,seq,type,client_command_id) values
      ('old-evt','conv','alice','device','{"messageId":"old"}',1,'message.created','old-history'),
      ('new-evt','conv','alice','device','{"messageId":"new"}',2,'message.created','new-history'),
      ('evt','conv','alice','device','{"messageId":"message"}',3,'message.created','send'),
      ('evt-edit','conv','alice','device','{"messageId":"message","revision":2}',4,'message.edited','edit'),
      ('evt-revoke','conv','alice','device','{"messageId":"message","revision":3}',5,'message.revoked','revoke');
    insert into messages(id,event_id,conversation_id,create_seq,sender_user_id,revision,revoked_at) values
      ('old','old-evt','conv',1,'alice',2,now()),('new','new-evt','conv',2,'alice',2,now()),('message','evt','conv',3,'alice',3,now());
    insert into command_receipts(actor_device_id,command_type,client_command_id,request_fingerprint,state,result_event_id,response_code,response_payload,completed_at) values
      ('device','message.create','send',repeat('a',64),'completed','evt','OK','{"message":{"id":"message","seq":3},"eventId":"evt"}',now()),
      ('device','message.edit','edit',repeat('b',64),'completed','evt-edit','OK','{"result":{"message":{"id":"message","conversationId":"conv","seq":3,"revision":2}},"eventId":"evt-edit"}',now()),
      ('device','message.revoke','revoke',repeat('c',64),'completed','evt-revoke','OK','{"result":{"message":{"id":"message","conversationId":"conv","seq":3,"revision":3,"revoked":true}},"eventId":"evt-revoke"}',now());
  `);
  await pool.query("insert into device_public_keys values($1,$2)", ["device", key.publicKey.export({ type: "spki", format: "pem" })]);
  registerCollaborationRoutes(app, { database: db, authorizeMessage: async (input) => {
    const decision = await authorize(input);
    if (historyBarrier) { historyBarrier.entered.resolve(); await historyBarrier.release.promise; }
    return decision;
  } });
  const own = await receipt("alice");
  assert.equal(own.status, 200); assert.equal(own.body.committed, true); assert.equal(own.body.messageId, "message");
  const edit = await receipt("alice", { clientCommandId: "edit", commandType: "message.edit", expectedMessageId: "message", expectedRevision: 1 });
  assert.deepEqual({ type: edit.body.commandType, messageId: edit.body.messageId, revision: edit.body.revision, eventSequence: edit.body.eventSequence }, { type: "message.edit", messageId: "message", revision: 2, eventSequence: 4 }, "typed edit receipt binds the mutation target and revision to its device event, not creation seq 3");
  const revoke = await receipt("alice", { clientCommandId: "revoke", commandType: "message.revoke", expectedMessageId: "message", expectedRevision: 2 });
  assert.equal(revoke.body.revoked, true, "typed revoke receipt carries positive tombstone evidence");
  assert.equal(revoke.body.eventSequence, 5, "revoke event order is distinct from the immutable creation seq");
  assert.equal((await receipt("alice", { clientCommandId: "edit", commandType: "message.edit", expectedMessageId: "new", expectedRevision: 1 })).body.code, "COLLAB_RECEIPT_IDENTITY_DENIED", "a target mismatch is never exposed as a usable mutation receipt");
  assert.equal((await receipt("bob")).body.code, "COLLAB_RECEIPT_IDENTITY_DENIED", "same physical device/new account cannot read old actor receipt");
  assert.equal((await receipt("alice", { expectedConversationId: "different" })).body.code, "COLLAB_RECEIPT_IDENTITY_DENIED");
  assert.equal((await receipt("alice", {}, { validSignature: false })).status, 401);
  const history = await receipt("alice", { action: "history", conversationId: "conv", messageIds: ["old"] }, { route: "/api/collaboration/v1/messages" });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.deepEqual(history.body.result.messages.map((row) => row.id), ["old"], "signed HTTP schema passes targeted IDs to the SQL history filter");
  assert.deepEqual(history.body.result.unavailableMessageIds, []);
  assert.equal(history.body.result.messages[0].bodyText, null); assert.equal(history.body.result.messages[0].revision, 2);
  await pool.query("update conversation_members set joined_seq=1 where user_id='alice'");
  const invisible = await receipt("alice", { action: "history", conversationId: "conv", messageIds: ["old"] }, { route: "/api/collaboration/v1/messages" });
  assert.deepEqual(invisible.body.result, { messages: [], unavailableMessageIds: ["old"] }, "authorized nonvisibility has explicit proof, never a silent missing body");
  await pool.query("update conversation_members set joined_seq=0 where user_id='alice'");
  const invalidHistory = await receipt("alice", { action: "history", conversationId: "conv", messageIds: ["old"], beforeSeq: 2 }, { route: "/api/collaboration/v1/messages" });
  assert.equal(invalidHistory.status, 400, "targeted lookup cannot also paginate");
  historyBarrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const ongoing = receipt("alice", { action: "history", conversationId: "conv", messageIds: ["old"] }, { route: "/api/collaboration/v1/messages" });
  await historyBarrier.entered.promise;
  const remover = await pool.connect();
  let removal;
  try {
    await remover.query("set lock_timeout='5s'");
    const { rows: [{ pid }] } = await remover.query("select pg_backend_pid() AS pid");
    removal = remover.query("update conversation_members set status='removed' where user_id='alice'");
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const probe = await pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
      waiting = probe.rows[0]?.wait_event_type === "Lock";
    }
    assert.equal(waiting, true, "membership revoke waits while authorized history holds the same transaction locks");
  } finally {
    historyBarrier.release.resolve(); historyBarrier = null;
    await removal; remover.release();
  }
  assert.equal((await ongoing).status, 200, "in-flight history linearizes before the waiting revocation");
  const deniedHistory = await receipt("alice", { action: "history", conversationId: "conv", messageIds: ["old"] }, { route: "/api/collaboration/v1/messages" });
  assert.equal(deniedHistory.status >= 400, true, "after revoke commits, history returns no body");
  assert.equal(deniedHistory.body.result, undefined);
  await pool.query("update conversation_members set status='active' where user_id='alice'");
  await pool.query("update user_sessions set revoked_at=now() where user_id='alice'");
  const revoked = await receipt("alice");
  assert.equal(revoked.body.code, "SESSION_EXPIRED", "revoked login rejects a still-cryptographically-valid bearer token");
  assert.equal(revoked.body.retryable, false); assert.equal(typeof revoked.body.requestId, "string", "shared guard preserves collaboration's error envelope");
  await pool.query("update user_sessions set revoked_at=null where user_id='alice'; update user_devices set status='revoked' where user_id='alice'");
  assert.equal((await receipt("alice")).body.code, "COLLAB_DEVICE_REVOKED");
  await pool.query("update user_devices set status='active'; update conversation_members set status='removed' where user_id='alice'");
  const removed = await receipt("alice");
  assert.equal(removed.status, 403, `receipt access reauthorizes current conversation membership: ${JSON.stringify(removed.body)}`);
  console.log("collaboration receipt integration: signed HTTP and real PostgreSQL passed");
} finally { await app.close(); await closeDb(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
