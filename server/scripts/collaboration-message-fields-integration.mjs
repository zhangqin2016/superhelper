import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import pg from "pg";
import Fastify from "fastify";

if (!process.env.DATABASE_URL) {
  console.log("collaboration message fields integration: skipped (DATABASE_URL is not configured)");
  process.exit(0);
}
const schema = `collab_fields_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
Object.assign(process.env, {
  DATABASE_URL: scoped.href, SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  COLLABORATION_ENABLED: "true", COLLABORATION_KILL_SWITCH: "false", COLLABORATION_ROLLOUT_ORGANIZATIONS: "",
  COLLAB_MESSAGE_KEK: crypto.randomBytes(32).toString("hex"), COLLAB_MESSAGE_KEK_VERSION: "v1",
});
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { createAccessToken }, { stableStringify, sha256 }, { installDocOnlyCompilers }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/services/account-auth.js"),
  import("../src/services/security.js"), import("../src/openapi.js"),
]);
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring.js");
const { createCollaborationClient } = require("../../src/main/collaboration/client.js");
const { createCollaborationOutboxTransport } = require("../../src/main/collaboration/message-outbox-transport.js");
const { createCollaborationOutbox } = require("../../src/main/collaboration/outbox.js");
const { createCollaborationService } = require("../../src/main/collaboration/service.js");
const { hydratePendingConversation } = require("../../src/main/collaboration/history-hydration.js");
const { createCollaborationIpc } = require("../../src/main/ipc-collaboration.js");
const app = Fastify({ logger: false });
installDocOnlyCompilers(app);
const identities = new Map();
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-fields-pg-"));
const options = {
  dbPath: path.join(localDir, "cache.db"), accountId: "alice",
  keyring: new LocalCollaborationKeyring({ filePath: path.join(localDir, "keys"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } }),
};
let store, service, recovering;
const sentCommands = [];
function clientFor(userId, { malformedAck = false } = {}) {
  const identity = identities.get(userId), deviceId = `device-${userId}`;
  const token = createAccessToken({ userId, deviceId, sessionId: `session-${userId}` });
  return createCollaborationClient({
    accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: token }) },
    async signDeviceRequest({ path: pathname, method, body }) {
      const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
      const signature = crypto.sign(null, Buffer.from(stableStringify({ method, pathname, timestamp, nonce, bodyHash })), identity.privateKey).toString("base64url");
      return { "x-lily-device-id": deviceId, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce, "x-lily-body-sha256": bodyHash, "x-lily-signature": signature };
    },
    async request({ path: pathname, method, body, headers }) {
      if (body.action === "send") sentCommands.push(structuredClone(body));
      const response = await app.inject({ method, url: pathname, payload: body, headers });
      // Fault injection occurs only after the real signed request and commit.
      const json = malformedAck && body.clientCommandId === "desktop-fields" && response.statusCode === 200 ? { ok: true } : response.json();
      return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json };
    },
  });
}

try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key); create table devices(id text primary key);
    create table user_devices(user_id text,device_id text,status text,primary key(user_id,device_id));
    create table user_profiles(user_id text primary key,lily_id text,display_name text,avatar_object_id text,discoverability text);
    create table organizations(id text primary key,name text,status text);
    create table organization_members(organization_id text,user_id text,role text,status text,joined_at timestamptz default now(),primary key(organization_id,user_id));
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
    insert into users values('alice'),('bob');
    insert into user_profiles values('alice','alice','Alice',null,'contacts'),('bob','bob','Bob',null,'contacts');
  `);
  for (const migration of ["033_collaboration_core.sql", "035_collaboration_bootstrap_completion.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "040_collaboration_trusted_actors.sql", "041_collaboration_reply_snapshots.sql"]) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  for (const userId of ["alice", "bob"]) {
    const key = crypto.generateKeyPairSync("ed25519"); identities.set(userId, key);
    await pool.query("insert into devices values($1)", [`device-${userId}`]);
    await pool.query("insert into user_devices values($1,$2,'active')", [userId, `device-${userId}`]);
    await pool.query("insert into user_sessions values($1,$2,$3,null,now()+interval '1 hour')", [`session-${userId}`, userId, `device-${userId}`]);
    await pool.query("insert into device_public_keys values($1,$2)", [`device-${userId}`, key.publicKey.export({ type: "spki", format: "pem" })]);
  }
  await pool.query(`
    insert into conversations(id,scope_type,kind,created_by) values('group','personal','group','bob');
    insert into conversation_members(conversation_id,user_id,role) values('group','alice','member'),('group','bob','owner');
  `);
  registerCollaborationRoutes(app, { database: db });
  const bob = clientFor("bob");
  const source = (await bob.submitMessage({ action: "send", deviceId: "device-bob", conversationId: "group", clientCommandId: "source", bodyText: "source message" })).result.message;
  store = new CollaborationStore(options);
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "group", kind: "group" }] });
  const client = clientFor("alice", { malformedAck: true });
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device-alice", realtimeEnabled: false,
    transport: createCollaborationOutboxTransport({ client, deviceId: "device-alice" }) });
  service.saveDraft({ conversationId: "group", text: "same text", replyToMessageId: null, mentionUserIds: [] });
  const intent = { conversationId: "group", clientCommandId: "desktop-fields", bodyText: "same text", replyToMessageId: source.id, mentionUserIds: ["bob"] };
  await service.send(intent);
  const stored = (await pool.query("select * from messages where conversation_id='group' and sender_user_id='alice'")).rows[0];
  assert.equal(stored.reply_to_message_id, source.id, "desktop reply identity reaches the actual server projection");
  const creation = (await pool.query("select payload from collaboration_events where id=$1", [stored.event_id])).rows[0];
  assert.deepEqual(creation.payload.mentionUserIds, ["bob"], "mentions survive the production transport and original creation event");
  assert.equal(store.getOutbox({ outboxId: intent.clientCommandId }).deliveryConfirmed, false, "a malformed HTTP 200 is not delivery proof");
  assert.equal(store.getOutbox({ outboxId: intent.clientCommandId }).state, "confirming");
  assert.equal(service.getDraft({ conversationId: "group" }).text, "same text", "same text with different reply/mention intent remains an unsent draft");
  assert.equal((await service.send({ ...intent, mentionUserIds: [] })).code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(sentCommands.filter((c) => c.clientCommandId === intent.clientCommandId).length, 1);
  service.stop(); service = null;

  store = new CollaborationStore(options);
  const fresh = clientFor("alice");
  recovering = createCollaborationOutbox({ store, deviceId: "device-alice", transport: createCollaborationOutboxTransport({ client: fresh, deviceId: "device-alice" }) });
  await recovering.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: intent.clientCommandId }).state, "persisted");
  assert.equal(sentCommands.filter((c) => c.clientCommandId === intent.clientCommandId).length, 1, "receipt recovery cannot create a second send");
  // A server-owned old date must not turn into today's cache insertion time.
  const serverDate = new Date("2026-08-01T12:34:56.000Z");
  await pool.query("update messages set created_at=$1 where id=$2", [serverDate, stored.id]);
  await hydratePendingConversation({ store, client: fresh, deviceId: "device-alice", conversationId: "group", assertActive() {} });
  const message = store.getMessage({ conversationId: "group", messageId: stored.id });
  assert.equal(message.replyToMessageId, source.id);
  assert.deepEqual(message.mentionUserIds, ["bob"]);
  assert.equal(message.senderUserId, "alice");
  assert.equal(message.createdAt, serverDate.getTime());
  recovering.stop(); recovering = null; store.close(); store = new CollaborationStore(options);
  const reopened = store.listMessages({ conversationId: "group" }).find((m) => m.id === stored.id);
  assert.equal(reopened.createdAt, serverDate.getTime(), "authoritative message age survives SQLite reopen");
  assert.deepEqual(reopened.mentionUserIds, ["bob"]);
  service = createCollaborationService({ openStore: () => ({ ok: true, store }) });
  const handlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  const view = await handlers.get("collaboration:read-messages")(null, { conversationId: "group", messageIds: [stored.id] });
  assert.equal(view.messages[0].createdAt, serverDate.getTime());
  assert.equal(view.messages[0].senderUserId, "alice");
  assert.deepEqual(view.messages[0].mentionUserIds, ["bob"]);

  // Upgrade fixture: retain a real completed command/event, then populate its
  // encrypted body and fingerprint as an already-existing 64 KiB-era message.
  // The new request/replay below still traverses the actual signed HTTP kernel.
  const legacyCommand = { action: "send", deviceId: "device-alice", conversationId: "group", clientCommandId: "legacy-64", bodyText: "upgrade fixture seed" };
  const legacyReceipt = await fresh.submitMessage(legacyCommand);
  const legacyText = "x".repeat(64 * 1024);
  const [{ createCollaborationMessageCrypto }, { createHmacMessageBodyIntentSigner }, { collaborationRequestFingerprint }] = await Promise.all([
    import("../src/services/collaboration/message-crypto.js"), import("../src/services/collaboration/message-input.js"), import("../src/services/collaboration/idempotency.js"),
  ]);
  const kek = Buffer.from(process.env.COLLAB_MESSAGE_KEK, "hex");
  const encrypted = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: kek } }).encrypt({
    plaintext: Buffer.from(legacyText), messageId: legacyReceipt.result.message.id, conversationId: "group", revision: 1,
  });
  const signer = createHmacMessageBodyIntentSigner({ key: crypto.createHash("sha256").update("lily-collab-message-intent-v1").update(kek).digest() });
  const fingerprint = collaborationRequestFingerprint({ conversationId: "group", bodyIntent: signer.sign({
    bodyText: legacyText, conversationId: "group", actorUserId: "alice", commandType: "message.create",
  }), bodyIntentKeyVersion: 1, replyToMessageId: null, attachmentIds: [], mentionUserIds: [] });
  await pool.query("update messages set body_ciphertext=$1,body_key_version=$2 where id=$3", [encrypted.ciphertext, encrypted.keyVersion, legacyReceipt.result.message.id]);
  await pool.query("update command_receipts set request_fingerprint=$1 where actor_device_id='device-alice' and command_type='message.create' and client_command_id='legacy-64'", [fingerprint]);
  assert.deepEqual((await fresh.submitMessage({ ...legacyCommand, bodyText: legacyText })).result, legacyReceipt.result,
    "the new size policy cannot strand an already-committed legacy 64 KiB command");
  await assert.rejects(() => fresh.submitMessage({ ...legacyCommand, clientCommandId: "new-64", bodyText: legacyText }),
    (error) => error.code === "COLLAB_MESSAGE_BODY_TOO_LARGE", "new 64 KiB admission is rejected after the legacy receipt path");
  const legacyHistory = await fresh.listMessageHistory({ deviceId: "device-alice", conversationId: "group", messageIds: [legacyReceipt.result.message.id] });
  assert.equal(legacyHistory.messages[0].bodyText, legacyText, "old large history remains readable without truncation");

  // Use a new command: idempotent receipt replay intentionally retains its
  // earlier committed result, whereas new replies must obey current visibility.
  await pool.query("update conversation_members set joined_seq=$1 where conversation_id='group' and user_id='alice'", [source.seq]);
  await assert.rejects(() => fresh.submitMessage({ ...intent, action: "send", deviceId: "device-alice", clientCommandId: "hidden-source" }),
    (error) => error.code === "COLLAB_REPLY_TARGET_INVALID", "a pre-join source cannot be referenced by a new reply");
  assert.equal((await pool.query("select count(*)::int as n from messages where conversation_id='group'")).rows[0].n, 3);
  console.log("collaboration message fields integration: signed desktop reply/mention, malformed ACK, receipt restart, authoritative cache age and visibility passed");
} finally {
  recovering?.stop(); if (service) service.stop(); else try { store?.close(); } catch {}
  await app.close(); await closeDb(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  fs.rmSync(localDir, { recursive: true, force: true });
}
