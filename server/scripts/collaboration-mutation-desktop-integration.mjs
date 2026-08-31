import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import pg from "pg";
import Fastify from "fastify";

if (!process.env.DATABASE_URL) { console.log("collaboration mutation desktop integration: skipped (DATABASE_URL is not configured)"); process.exit(0); }
const connectionString = process.env.DATABASE_URL;
const schema = `collab_mutation_desktop_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const scoped = new URL(connectionString); scoped.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = scoped.href;
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.COLLABORATION_ENABLED = "true";
process.env.COLLABORATION_KILL_SWITCH = "false";
process.env.COLLABORATION_ROLLOUT_ORGANIZATIONS = "";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring.js");
const { createCollaborationOutbox } = require("../../src/main/collaboration/outbox.js");
const { createCollaborationClient } = require("../../src/main/collaboration/client.js");
const { createCollaborationOutboxTransport } = require("../../src/main/collaboration/message-outbox-transport.js");
const { hydratePendingConversation } = require("../../src/main/collaboration/history-hydration.js");
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { createAccessToken }, { stableStringify, sha256 }, { createCollaborationMessageService, createHmacMessageBodyIntentSigner }, { createCollaborationMessageCrypto }, { createKyselyMessageRepository, createLockedMessageAuthorizer }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/services/account-auth.js"), import("../src/services/security.js"),
  import("../src/services/collaboration/messages.js"), import("../src/services/collaboration/message-crypto.js"), import("../src/services/collaboration/message-repository.js"),
]);

const key = crypto.generateKeyPairSync("ed25519");
const deviceId = "device-a", accountId = "user-a", conversationId = "conv-1";
const token = createAccessToken({ userId: accountId, deviceId, sessionId: "session-a" });
const app = Fastify({ logger: false });
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-mutation-pg-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };

function openStore() {
  return new CollaborationStore({ dbPath: path.join(localDir, "collaboration.db"), accountId, keyring: new LocalCollaborationKeyring({ filePath: path.join(localDir, "keys.json"), safeStorage }) });
}
function signedClient() {
  return createCollaborationClient({
    accountManager: { accountStatus: () => ({ loggedIn: true, user: { id: accountId } }), async accessTokenForService() { return { ok: true, accessToken: token }; } },
    async signDeviceRequest({ path: pathname, method, body, deviceId: signedDevice }) {
      const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
      const signature = crypto.sign(null, Buffer.from(stableStringify({ method, pathname, timestamp, nonce, bodyHash })), key.privateKey).toString("base64url");
      return { "x-lily-device-id": signedDevice, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce, "x-lily-body-sha256": bodyHash, "x-lily-signature": signature };
    },
    async request({ path: pathname, method, body, headers }) {
      const response = await app.inject({ method, url: pathname, payload: body, headers: { authorization: `Bearer ${token}`, ...headers } });
      return { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, json: response.json() };
    },
  });
}

try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key); create table devices(id text primary key);
    create table device_public_keys(device_id text primary key,public_key text); create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
    create table user_devices(user_id text,device_id text,status text,primary key(user_id,device_id));
    create table organizations(id text primary key,status text); create table organization_members(organization_id text,user_id text,status text,role text);
  `);
  // Only account prerequisites are fixtures. Exercise the shipped collaboration
  // constraints and columns so a hand-written schema cannot hide SQL drift.
  for (const migration of ["033_collaboration_core.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "040_collaboration_trusted_actors.sql", "041_collaboration_reply_snapshots.sql"]) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    insert into users values('user-a'),('user-b'); insert into devices values('device-a');
    insert into user_devices values('user-a','device-a','active'); insert into user_sessions values('session-a','user-a','device-a',null,now()+interval '1 hour');
    insert into friendships(user_low_id,user_high_id,status) values('user-a','user-b','active');
    insert into conversations(id,scope_type,kind,direct_user_low_id,direct_user_high_id,direct_pair_key,created_by)
      values('conv-1','personal','direct','user-a','user-b','user-a:user-b','user-a');
    insert into conversation_members(conversation_id,user_id,status,role,joined_seq,last_read_seq)
      values('conv-1','user-a','active','member',0,0),('conv-1','user-b','active','member',0,0);
  `);
  await pool.query("insert into device_public_keys values($1,$2)", [deviceId, key.publicKey.export({ type: "spki", format: "pem" })]);
  const kek = Buffer.alloc(32, 7);
  const messageService = createCollaborationMessageService({ repository: createKyselyMessageRepository(db), messageCrypto: createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: kek } }), bodyIntentSigner: createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 8) }) });
  registerCollaborationRoutes(app, { database: db, messageService, authorizeMessage: createLockedMessageAuthorizer(), authorizeReceipt: createLockedMessageAuthorizer() });
  const client = signedClient();
  const sent = await client.submitMessage({ action: "send", deviceId, conversationId, clientCommandId: "seed-create", bodyText: "before" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const serverMessage = sent.result.message;
  assert.equal(typeof serverMessage.id, "string", "server chooses the immutable message id");

  let store = openStore();
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES(?,?,?,?,?)", accountId, conversationId, "personal", "direct", 1);
  store.hydrateAuthorizedHistory({ conversationId, messages: [{ id: serverMessage.id, conversationId, bodyText: "before", revision: 1, createSeq: serverMessage.seq }] });
  const editId = "desktop-edit";
  store.persistMessageMutation({ commandType: "message.edit", conversationId, messageId: serverMessage.id, clientCommandId: editId, expectedRevision: 1, bodyText: "after", originDeviceId: deviceId });
  const transport = createCollaborationOutboxTransport({ client, deviceId });
  const lostEditAck = createCollaborationOutbox({ store, deviceId, transport: { ...transport, async submit(item) { await transport.submit(item); throw Object.assign(new Error("drop desktop edit ACK"), { code: "COLLAB_RESPONSE_UNKNOWN" }); } } });
  await lostEditAck.submit(editId);
  assert.equal(store.getOutbox({ outboxId: editId }).state, "confirming", "desktop stores the edit before the dropped ACK");
  lostEditAck.stop(); store.close(); store = openStore();
  const recoveredEdit = createCollaborationOutbox({ store, deviceId, transport });
  await recoveredEdit.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: editId }).state, "persisted", "typed receipt settles the exact edit after SQLite reopen without replay");
  await hydratePendingConversation({ store, client, deviceId, conversationId, assertActive() {} });
  const edited = store.getMessage({ conversationId, messageId: serverMessage.id });
  assert.deepEqual({ bodyText: edited.bodyText, revision: edited.revision, seq: edited.seq }, { bodyText: "after", revision: 2, seq: serverMessage.seq }, "authorized history applies edit revision without changing create sequence");

  const revokeId = "desktop-revoke";
  store.persistMessageMutation({ commandType: "message.revoke", conversationId, messageId: serverMessage.id, clientCommandId: revokeId, expectedRevision: 2, originDeviceId: deviceId });
  const lostRevokeAck = createCollaborationOutbox({ store, deviceId, transport: { ...transport, async submit(item) { await transport.submit(item); throw Object.assign(new Error("drop desktop revoke ACK"), { code: "COLLAB_RESPONSE_UNKNOWN" }); } } });
  await lostRevokeAck.submit(revokeId); lostRevokeAck.stop(); recoveredEdit.stop(); store.close(); store = openStore();
  const recoveredRevoke = createCollaborationOutbox({ store, deviceId, transport });
  await recoveredRevoke.reconcilePending();
  await hydratePendingConversation({ store, client, deviceId, conversationId, assertActive() {} });
  const revoked = store.getMessage({ conversationId, messageId: serverMessage.id });
  assert.deepEqual({ revision: revoked.revision, revokedAt: Boolean(revoked.revokedAt), bodyText: revoked.bodyText, seq: revoked.seq }, { revision: 3, revokedAt: true, bodyText: "", seq: serverMessage.seq }, "revoke receipt and authorized history survive ACK loss/restart without resurrecting the target");
  const persistedEvents = await pool.query("select type, count(*)::int as count from collaboration_events where conversation_id=$1 group by type order by type", [conversationId]);
  assert.deepEqual(persistedEvents.rows, [
    { type: "message.created", count: 1 }, { type: "message.edited", count: 1 }, { type: "message.revoked", count: 1 },
  ], "lost acknowledgments and desktop recovery must not create duplicate server events");
  const persistedMessage = await pool.query("select event_id,create_seq,revision from messages where id=$1", [serverMessage.id]);
  assert.deepEqual(persistedMessage.rows, [{ event_id: sent.result.eventId, create_seq: String(serverMessage.seq), revision: 3 }],
    "both mutations preserve the original creation event and its sequence under actual foreign keys");
  recoveredRevoke.stop(); store.close();
  console.log("collaboration mutation desktop integration: real PG HTTP + SQLite ACK-loss recovery passed");
} finally {
  await app.close(); await closeDb(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  try { fs.rmSync(localDir, { recursive: true, force: true }); } catch {}
}
