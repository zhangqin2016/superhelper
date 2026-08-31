#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) { console.log("collaboration objects PG: skipped (DATABASE_URL is not configured)"); process.exit(0); }
const [{ default: pg }, { Kysely, PostgresDialect, sql }, { createKyselyObjectRepository }, { createCollaborationObjectService }, { createCollaborationObjectKeyBroker }, { createKyselyConversationRepository }, { createCollaborationConversationService }, { runCollaborationCommand }, { createCollaborationMessageService, createHmacMessageBodyIntentSigner }, { createCollaborationMessageCrypto }, { createKyselyMessageRepository }] = await Promise.all([
  import("pg"), import("kysely"), import("../src/services/collaboration/object-repository.js"), import("../src/services/collaboration/objects.js"), import("../src/services/collaboration/object-key-broker.js"), import("../src/services/collaboration/conversation-repository.js"), import("../src/services/collaboration/conversations.js"), import("../src/services/collaboration/command-runner.js"), import("../src/services/collaboration/messages.js"), import("../src/services/collaboration/message-crypto.js"), import("../src/services/collaboration/message-repository.js"),
]);
const schema = `collab_obj_it_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, application_name: schema });
const queries = [];
const db = new Kysely({ dialect: new PostgresDialect({ pool }), log: (event) => { if (event.level === "query") queries.push(event.query.sql); } });
const account = (userId) => ({ userId, deviceId: `device-${userId}` });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
try {
  await admin.query(`create schema ${schema}`);
  await pool.query("create table users(id text primary key); create table devices(id text primary key); create table user_devices(user_id text references users(id),device_id text references devices(id),status text default 'active',primary key(user_id,device_id)); create table organizations(id text primary key,status text); create table organization_members(organization_id text references organizations(id),user_id text references users(id),status text,role text,primary key(organization_id,user_id))");
  for (const migration of ["033_collaboration_core.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "039_collaboration_objects.sql"]) await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  await pool.query("insert into users values('a'),('b'),('c'); insert into devices values('device-a'),('device-b'),('device-c'); insert into user_devices(user_id,device_id) values('a','device-a'),('b','device-b'),('c','device-c'); insert into organizations values('org','active'); insert into organization_members values('org','a','active','owner'),('org','b','active','member'),('org','c','active','member')");
  const conversations = createKyselyConversationRepository(db);
  const conversationService = createCollaborationConversationService({ repository: conversations });
  const conv = await conversationService.createConversation({ account: account("a"), clientCommandId: "create-private", scopeType: "organization", organizationId: "org", kind: "channel", visibility: "private", memberUserIds: ["a", "b"] });
  const other = await conversationService.createConversation({ account: account("a"), clientCommandId: "create-other", scopeType: "personal", kind: "group", memberUserIds: ["a", "b"] });
  const repository = createKyselyObjectRepository(db, { conversations });
  const timeouts = await repository.withTransaction(async (trx) => (await sql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout`.execute(trx)).rows[0]);
  assert.deepEqual(timeouts, { lock_timeout: "2s", statement_timeout: "8s" }, "credential/preflight transactions use the same bounded waits as command writes");
  const broker = createCollaborationObjectKeyBroker({ currentKekVersion: 1, kekByVersion: { 1: Buffer.alloc(32, 7) } });
  const uploaded = new Map(); let ticketCount = 0;
  const objectStore = {
    createObjectKey: () => `collaboration/${crypto.randomBytes(32).toString("hex")}`,
    createUploadTicket: ({ objectKey, ttlSeconds }) => ({ objectKey, token: "secret-upload-token", expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() }),
    createDownloadTicket: ({ objectKey, ttlSeconds }) => { ticketCount++; return { url: `https://private.invalid/${objectKey}?token=secret-download`, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() }; },
    head: async ({ objectKey }) => uploaded.get(objectKey),
  };
  const service = createCollaborationObjectService({ repository, keyBroker: broker, objectStore });
  const messageRepository = createKyselyMessageRepository(db);
  const messages = createCollaborationMessageService({ repository: messageRepository, objectService: service, messageCrypto: createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: Buffer.alloc(32, 4) } }), bodyIntentSigner: createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 3) }) });
  const dek = Buffer.alloc(32, 9); const hash = "a".repeat(64);
  const metadata = { conversationId: conv.conversationId, purpose: "attachment", ciphertextSize: 100, ciphertextSha256: hash, mimeType: "text/plain", originalName: "notes.txt" };
  const init = (key, overrides = {}, source = service) => source.init({ account: account("a"), clientCommandId: key, ...metadata, dek, ...overrides });
  const getObject = async (id) => (await pool.query("select * from stored_objects where id=$1", [id])).rows[0];
  const complete = (objectId, key) => service.complete({ account: account("a"), clientCommandId: key, objectId, etag: "etag-a", ciphertextSize: 100, ciphertextSha256: hash });
  const ready = async (key) => {
    const result = await init(key); const object = await getObject(result.objectId);
    uploaded.set(object.object_key, { objectKey: object.object_key, ciphertextSize: 100, ciphertextSha256: hash, mimeType: "application/octet-stream", etag: "etag-a" });
    assert.equal((await complete(result.objectId, `${key}-complete`)).state, "verified");
    return result;
  };
  const first = await init("init-1");
  for (const objectId of [first.objectId, "object-does-not-exist"]) {
    await assert.rejects(service.downloadTicket({ account: account("c"), objectId }), (e) => e.code === "COLLAB_OBJECT_UNAVAILABLE", "private-scope and missing object denials must be indistinguishable");
    await assert.rejects(service.abort({ account: account("b"), objectId, clientCommandId: `deny-owner-${objectId}` }), (e) => e.code === "COLLAB_OBJECT_UNAVAILABLE", "other-owner and missing object denials must be indistinguishable");
  }
  const shortExpiry = new Date(Date.now() + 5000).toISOString();
  const shortUpload = await init("short-expiry", { expiresAt: shortExpiry });
  assert.ok(new Date(shortUpload.upload.expiresAt).getTime() <= new Date(shortExpiry).getTime(), "upload capability cannot outlive explicit object expiry");
  assert.equal((await getObject(first.objectId)).state, "uploading");
  assert.equal((await init("init-1")).objectId, first.objectId);
  await assert.rejects(init("init-1", { dek: Buffer.alloc(32, 8) }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED");
  const storedKeys = (await pool.query("select wrapped_dek,kek_version from object_keys where object_id=$1", [first.objectId])).rows[0];
  assert.equal(Buffer.from(storedKeys.wrapped_dek).includes(dek), false);
  const receipts = JSON.stringify((await pool.query("select response_payload from command_receipts")).rows);
  assert.equal(receipts.includes("secret-upload-token"), false);
  assert.equal(receipts.includes(dek.toString("base64")), false);
  await assert.rejects(service.complete({ account: account("b"), clientCommandId: "wrong-owner-complete", objectId: first.objectId, etag: "etag-a", ciphertextSize: 100, ciphertextSha256: hash }), (e) => e.code === "COLLAB_OBJECT_UNAVAILABLE");
  const firstRow = await getObject(first.objectId);
  uploaded.set(firstRow.object_key, { objectKey: firstRow.object_key, ciphertextSize: 99, ciphertextSha256: hash, mimeType: "application/octet-stream", etag: "etag-a" });
  assert.equal((await complete(first.objectId, "complete-mismatch")).state, "rejected");
  assert.equal((await pool.query("select count(*)::int as n from object_keys where object_id=$1", [first.objectId])).rows[0].n, 0);
  assert.equal((await pool.query("select count(*)::int as n from object_cleanup_jobs where object_id=$1", [first.objectId])).rows[0].n, 1);

  const attached = await ready("ready-1");
  await assert.rejects(service.bindToMessage({ trx: db, account: account("a"), conversationId: conv.conversationId, messageId: "missing", objectIds: [attached.objectId] }), (e) => e.code === "COLLAB_OBJECT_TRANSACTION_REQUIRED", "binding cannot accidentally autocommit outside the message transaction");
  await assert.rejects(service.downloadTicket({ account: account("a"), objectId: attached.objectId }), (e) => e.code === "COLLAB_OBJECT_UNAVAILABLE", "unbound owner cannot mint a download capability");
  const bindMessage = (objectId, commandId, conversationId = conv.conversationId, extra = {}) => messages.sendMessage({ account: account("a"), clientCommandId: commandId, conversationId, attachmentIds: [objectId], database: db, authorize: conversations.authorizeAction, ...extra });
  // Actual message service, not a hand-written projection standing in for it.
  const sent = await bindMessage(attached.objectId, "bind-original", conv.conversationId, { bodyText: "caption" });
  assert.equal((await getObject(attached.objectId)).bound_message_id, sent.message.id);
  assert.deepEqual(await bindMessage(attached.objectId, "bind-original", conv.conversationId, { bodyText: "caption" }), sent, "lost ACK replays its original receipt, without rebinding");
  const history = await db.transaction().execute((trx) => messages.listMessageHistory({ trx, account: account("b"), conversationId: conv.conversationId, authorize: conversations.authorizeAction }));
  assert.deepEqual(history[0].attachmentIds, [attached.objectId]);
  assert.equal(history[0].bodyText, "caption");
  assert.equal(history[0].kind, "attachment", "a caption does not disguise an attachment as a pure text message");
  const crashObject = await ready("crash-binding");
  const beforeCrash = (await pool.query("select count(*)::int as n from messages")).rows[0].n;
  const crashMessages = createCollaborationMessageService({ repository: messageRepository, objectService: { ...service, async bindToMessage(input) { await service.bindToMessage(input); throw new Error("injected failure after binding, before user sync"); } }, messageCrypto: createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: Buffer.alloc(32, 4) } }), bodyIntentSigner: createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 3) }) });
  const crashingSend = { account: account("a"), clientCommandId: "crash-binding-send", conversationId: conv.conversationId, attachmentIds: [crashObject.objectId], database: db, authorize: conversations.authorizeAction };
  await assert.rejects(crashMessages.sendMessage(crashingSend), /injected failure/);
  assert.equal((await getObject(crashObject.objectId)).state, "verified", "a post-binding failure rolls back object CAS too");
  assert.equal((await pool.query("select count(*)::int as n from message_attachments where object_id=$1", [crashObject.objectId])).rows[0].n, 0);
  assert.equal((await pool.query("select count(*)::int as n from messages")).rows[0].n, beforeCrash);
  assert.equal((await pool.query("select count(*)::int as n from command_receipts where client_command_id=$1", [crashingSend.clientCommandId])).rows[0].n, 0);
  assert.equal((await pool.query("select count(*)::int as n from collaboration_events where client_command_id=$1", [crashingSend.clientCommandId])).rows[0].n, 0);
  queries.length = 0;
  await messages.sendMessage(crashingSend);
  const messageInsert = queries.findIndex((query) => query.startsWith('insert into "messages"'));
  const objectLock = queries.findIndex((query) => query.includes('from "stored_objects"') && query.includes("for update"));
  assert.ok(messageInsert >= 0 && objectLock > messageInsert, "real SQL must insert/lock message before taking any object locks");
  const workspace = await init("workspace-init", { purpose: "workspace" });
  const workspaceRow = await getObject(workspace.objectId);
  uploaded.set(workspaceRow.object_key, { objectKey: workspaceRow.object_key, ciphertextSize: 100, ciphertextSha256: hash, mimeType: "application/octet-stream", etag: "etag-a" });
  await complete(workspace.objectId, "workspace-complete");
  await assert.rejects(bindMessage(workspace.objectId, "wrong-purpose"), (e) => e.code === "COLLAB_ATTACHMENT_NOT_READY");
  await bindMessage(workspace.objectId, "workspace-send", conv.conversationId, { attachmentPurpose: "workspace" });
  assert.equal((await pool.query("select purpose from message_attachments where object_id=$1", [workspace.objectId])).rows[0].purpose, "workspace");
  const competing = await ready("competing");
  await assert.rejects(bindMessage(competing.objectId, "bind-original"), (e) => e.code === "IDEMPOTENCY_KEY_REUSED", "attachment-only intent is immutable under the original command");
  await assert.rejects(bindMessage(competing.objectId, "cross-scope", other.conversationId), (e) => e.code === "COLLAB_ATTACHMENT_NOT_READY");
  const snapshot = async () => (await pool.query("select (select count(*)::int from messages) messages,(select count(*)::int from collaboration_events where type='message.created') events,(select count(*)::int from command_receipts where command_type='message.create') receipts,(select count(*)::int from user_sync_events) sync")).rows[0];
  const beforeCompete = await snapshot();
  const binds = await Promise.allSettled([bindMessage(competing.objectId, "bind-1"), bindMessage(competing.objectId, "bind-2")]);
  assert.equal(binds.filter((r) => r.status === "fulfilled").length, 1);
  const afterCompete = await snapshot();
  assert.deepEqual(afterCompete, { messages: beforeCompete.messages + 1, events: beforeCompete.events + 1, receipts: beforeCompete.receipts + 1, sync: beforeCompete.sync + 2 }, "losing command leaves no message, event, receipt or sync projection");
  assert.equal((await pool.query("select count(*)::int as n from message_attachments where object_id=$1", [attached.objectId])).rows[0].n, 1);
  const download = await service.downloadTicket({ account: account("b"), objectId: attached.objectId });
  assert.deepEqual(download.dek, dek); assert.equal(download.ciphertextSha256, hash);
  const downloadAudit = (await pool.query("select payload from collaboration_events where type='object.download_authorized' and actor_user_id='b'")).rows;
  assert.equal(downloadAudit.length, 1, "download authorization is audited without persisting the capability");
  assert.equal(JSON.stringify(downloadAudit).includes("secret-download"), false);
  const binding = (await pool.query("select bound_message_id from stored_objects where id=$1", [attached.objectId])).rows[0];
  await pool.query("update messages set revoked_at=now() where id=$1", [binding.bound_message_id]);
  await assert.rejects(service.downloadTicket({ account: account("a"), objectId: attached.objectId }), "message revocation blocks object access even before object cleanup");
  await pool.query("update messages set revoked_at=null where id=$1", [binding.bound_message_id]);
  await pool.query("update stored_objects set expires_at=now()-interval '1 second' where id=$1", [attached.objectId]);
  await assert.rejects(service.downloadTicket({ account: account("a"), objectId: attached.objectId }));
  await pool.query("update stored_objects set expires_at=null where id=$1", [attached.objectId]);
  const raceObject = await ready("ticket-race"); await bindMessage(raceObject.objectId, "bind-ticket-race");
  const lockHeld = deferred(); const releaseLock = deferred();
  const revoker = createCollaborationObjectService({ repository: { ...repository, async authorizeObject(trx, input) { const result = await repository.authorizeObject(trx, input); lockHeld.resolve(); await releaseLock.promise; return result; } }, keyBroker: broker, objectStore });
  const revocation = revoker.revoke({ account: account("a"), clientCommandId: "race-revoke", objectId: raceObject.objectId });
  await lockHeld.promise;
  const ticketsBeforeRace = ticketCount;
  const racingTicket = service.downloadTicket({ account: account("b"), objectId: raceObject.objectId }).then(() => ({ ok: true }), (error) => ({ error }));
  try {
    let blocked = false;
    for (let i = 0; i < 200 && !blocked; i++) blocked = Number((await admin.query("select count(*) as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [schema])).rows[0].n) > 0;
    assert.equal(blocked, true, "download really waits for the revocation authorization/object locks");
  } finally { releaseLock.resolve(); }
  await revocation;
  assert.equal((await racingTicket).error?.code, "COLLAB_OBJECT_UNAVAILABLE");
  assert.equal(ticketCount, ticketsBeforeRace);

  const headObject = await init("head-abort-race");
  const headStarted = deferred(); const releaseHead = deferred();
  const completingService = createCollaborationObjectService({ repository, keyBroker: broker, objectStore: { ...objectStore, async head({ objectKey }) { headStarted.resolve(); await releaseHead.promise; return { objectKey, ciphertextSize: 100, ciphertextSha256: hash, mimeType: "application/octet-stream", etag: "etag-a" }; } } });
  const completing = completingService.complete({ account: account("a"), objectId: headObject.objectId, clientCommandId: "complete-after-abort", etag: "etag-a", ciphertextSize: 100, ciphertextSha256: hash }).then(() => ({ ok: true }), (error) => ({ error }));
  await headStarted.promise;
  await service.abort({ account: account("a"), objectId: headObject.objectId, clientCommandId: "abort-during-head" });
  releaseHead.resolve();
  assert.equal((await completing).error?.code, "COLLAB_OBJECT_UNAVAILABLE");
  assert.equal((await getObject(headObject.objectId)).state, "aborted", "an old successful HEAD cannot revive an aborted upload");
  await assert.rejects(service.downloadTicket({ account: account("c"), objectId: attached.objectId }));
  await pool.query("update organization_members set status='disabled' where user_id='b'");
  const beforeRevokedTicket = ticketCount;
  await assert.rejects(service.downloadTicket({ account: account("b"), objectId: attached.objectId }));
  assert.equal(ticketCount, beforeRevokedTicket, "current Team revocation is checked before URL signing and key unwrapping");
  await assert.rejects(service.abort({ account: account("a"), objectId: attached.objectId, clientCommandId: "abort-bound" }));
  assert.equal((await service.revoke({ account: account("a"), objectId: attached.objectId, clientCommandId: "revoke-bound" })).state, "revoked");
  await assert.rejects(service.downloadTicket({ account: account("a"), objectId: attached.objectId }));
  const aborted = await init("abort-init");
  assert.equal((await service.abort({ account: account("a"), objectId: aborted.objectId, clientCommandId: "abort-1" })).state, "aborted");
  assert.ok(new Date((await pool.query("select available_at from object_cleanup_jobs where object_id=$1", [aborted.objectId])).rows[0].available_at).getTime() >= Date.now() + 890_000, "cleanup waits out issued upload capabilities so a late upload cannot resurrect deleted ciphertext");
  await assert.rejects(init("abort-init"), (e) => e.code === "COLLAB_OBJECT_UNAVAILABLE", "replayed init cannot issue credentials after abort");

  const unavailable = createCollaborationObjectService({ repository, keyBroker: null, objectStore });
  await assert.rejects(init("no-kek", {}, unavailable), (e) => e.code === "COLLAB_OBJECT_KEK_UNAVAILABLE");
  // Optional attachment failure does not install any global text-message gate.
  const text = await messages.sendMessage({ account: account("a"), clientCommandId: "text-after-object-kek-failure", conversationId: conv.conversationId, bodyText: "Text remains available", authorize: conversations.authorizeAction, database: db });
  assert.equal((await pool.query("select count(*)::int as n from messages where id=$1", [text.message.id])).rows[0].n, 1);
  console.log("collaboration objects PG: receipt secrecy, real CAS binding, HEAD rejection, cleanup, private authorization and revocation passed");
} finally { await db.destroy(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
