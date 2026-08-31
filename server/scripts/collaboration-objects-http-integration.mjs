import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import pg from "pg";
import Fastify from "fastify";
import { verifyTransferHttp } from "./collaboration-transfer-http-fixture.mjs";

if (!process.env.DATABASE_URL) { console.log("collaboration objects signed HTTP: skipped (DATABASE_URL not configured)"); process.exit(0); }
const schema = `collab_objects_http_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const oldCwd = process.cwd(), emptyCwd = await mkdtemp(join(tmpdir(), "collab-http-config-"));
process.chdir(emptyCwd); // dotenv must not load real operator/repository secrets.
Object.assign(process.env, {
  DATABASE_URL: scoped.href, SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  COLLABORATION_ENABLED: "true", COLLABORATION_KILL_SWITCH: "false", COLLABORATION_ROLLOUT_ORGANIZATIONS: "",
  COLLABORATION_ATTACHMENTS_ENABLED: "true", COLLABORATION_WORKSPACE_SHARES_ENABLED: "true",
  COLLAB_MESSAGE_KEK: crypto.randomBytes(32).toString("hex"), COLLAB_MESSAGE_KEK_VERSION: "v1",
  COLLAB_OBJECT_KEK: crypto.randomBytes(32).toString("hex"), COLLAB_OBJECT_KEK_VERSION: "v1", COLLAB_OBJECT_KEKS: "",
  COLLAB_QINIU_ACCESS_KEY: "test-private-ak", COLLAB_QINIU_SECRET_KEY: "test-private-sk", COLLAB_QINIU_BUCKET: "test-private-bucket",
  COLLAB_QINIU_PRIVATE_BASE_URL: "https://private.invalid", COLLAB_QINIU_UPLOAD_URL: "https://upload.invalid", COLLAB_QINIU_PRIVATE_BUCKET: "true",
  QINIU_BUCKET: "test-public-bucket", QINIU_PUBLIC_BASE_URL: "https://public.invalid",
});
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { config }, { createAccessToken }, { stableStringify, sha256 }, { installDocOnlyCompilers }, { createConfiguredCollaborationObjectService }, { createCollaborationSyncService }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/config.js"), import("../src/services/account-auth.js"), import("../src/services/security.js"), import("../src/openapi.js"), import("../src/services/collaboration/object-config.js"), import("../src/services/collaboration/sync-service.js"),
]);
const logs = [], sensitive = new Set();
const app = Fastify({ logger: { level: "trace", stream: new Writable({ write(chunk, _encoding, callback) { logs.push(chunk.toString()); callback(); } }) } });
installDocOnlyCompilers(app);
app.setErrorHandler((error, _request, reply) => { app.log.error(error); reply.code(500).send({ ok: false, code: "INTERNAL_ERROR" }); });
let dropAckPath = null, committedAck = null;
app.addHook("onSend", async (request, reply, payload) => {
  if (dropAckPath === request.url && reply.statusCode === 200) {
    // The real service has committed; prevent the client from receiving its
    // successful ACK, without replacing any database/service implementation.
    dropAckPath = null;
    committedAck = JSON.parse(payload).result;
    reply.code(503);
    return JSON.stringify({ ok: false, code: "TEST_ACK_LOST", retryable: true });
  }
  return payload;
});
const uploaded = new Map();
let providerUnavailable = false;
const objectService = createConfiguredCollaborationObjectService({ database: db, config, fetchImpl: async (url, options) => {
  if (providerUnavailable) return new Response(null, { status: 503 });
  const target = new URL(url), row = uploaded.get(target.pathname.slice(1));
  if (!row) return new Response(null, { status: 404 });
  if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(row.size), etag: "fake-etag", "content-type": "application/octet-stream" } });
  return Response.json({ hash: row.hash, fsize: row.size });
} });
const keys = new Map();
async function request(userId, endpoint, fields = {}, options = {}) {
  const deviceId = `device-${userId}`, pathname = `/api/collaboration/v1/${endpoint}`;
  const body = { deviceId, ...fields };
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
  const signature = crypto.sign(null, Buffer.from(stableStringify({ method: "POST", pathname, timestamp, nonce, bodyHash })), keys.get(userId).privateKey).toString("base64url");
  const token = createAccessToken({ userId, deviceId: options.tokenDeviceId || deviceId, sessionId: `session-${userId}` });
  sensitive.add(token);
  const response = await app.inject({ method: "POST", url: pathname, payload: options.payload || body, headers: {
    authorization: `Bearer ${token}`, "x-lily-device-id": deviceId, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce,
    "x-lily-body-sha256": bodyHash, "x-lily-signature": options.invalidSignature ? "invalid" : signature,
  } });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
const accepted = (response) => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result; };
const command = (user, endpoint, fields, options) => request(user, endpoint, { clientCommandId: crypto.randomUUID(), ...fields }, options);
try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`create table users(id text primary key); create table devices(id text primary key);
    create table user_devices(user_id text references users(id),device_id text references devices(id),status text default 'active',primary key(user_id,device_id));
    create table organizations(id text primary key,name text,status text);
    create table organization_members(organization_id text references organizations(id),user_id text references users(id),status text,role text,joined_at timestamptz default now(),primary key(organization_id,user_id));
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);`);
  for (const file of ["033_collaboration_core.sql", "035_collaboration_bootstrap_completion.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "039_collaboration_objects.sql", "041_collaboration_reply_snapshots.sql"]) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  for (const user of ["a", "b", "outsider"]) {
    const pair = crypto.generateKeyPairSync("ed25519"); keys.set(user, pair);
    await pool.query("insert into users values($1)", [user]);
    await pool.query("insert into devices values($1)", [`device-${user}`]);
    await pool.query("insert into user_devices(user_id,device_id) values($1,$2)", [user, `device-${user}`]);
    await pool.query("insert into device_public_keys values($1,$2)", [`device-${user}`, pair.publicKey.export({ type: "spki", format: "pem" })]);
    await pool.query("insert into user_sessions values($1,$2,$3,null,now()+interval '1 hour')", [`session-${user}`, user, `device-${user}`]);
    await pool.query("insert into device_sync_state(user_id,device_id) values($1,$2)", [user, `device-${user}`]);
  }
  await pool.query("insert into organizations values('org','Team','active'); insert into organization_members(organization_id,user_id,status,role) values('org','a','active','owner'),('org','b','active','member')");
  registerCollaborationRoutes(app, { database: db, objectService });
  for (const endpoint of ["init", "legacy-object/download-ticket"]) {
    const marker = `LEGACY_PARSER_SECRET_${endpoint}`;
    sensitive.add(marker);
    const malformed = await app.inject({ method: "POST", url: `/api/collaboration/objects/${endpoint}?token=${marker}`, headers: { "content-type": "application/json" }, payload: `{"dek":"${marker}", INVALID` });
    assert.equal(malformed.statusCode, 400, "legacy object parser must use the same safe boundary");
    assert.equal(malformed.headers["cache-control"], "no-store");
    assert.equal(logs.join("").includes(marker), false, "legacy parser errors and request URLs must not leak keys");
  }
  const conversationId = accepted(await command("a", "conversations", { action: "create", scopeType: "organization", organizationId: "org", kind: "channel", visibility: "private", memberUserIds: ["b"] })).conversationId;
  const dek = crypto.randomBytes(32).toString("base64"); sensitive.add(dek);
  const metadata = { conversationId, purpose: "attachment", ciphertextSize: 100, ciphertextSha256: "a".repeat(64), mimeType: "text/plain", originalName: "notes.txt", dek };
  dropAckPath = "/api/collaboration/v1/objects/init";
  assert.equal((await command("a", "objects/init", { ...metadata, clientCommandId: "init-original" })).status, 503);
  const originalObjectId = committedAck.objectId;
  const firstResponse = await command("a", "objects/init", { ...metadata, clientCommandId: "init-original" });
  const initial = accepted(firstResponse);
  assert.equal(initial.objectId, originalObjectId, "response loss after init commit never creates a second object");
  assert.equal(firstResponse.headers["cache-control"], "no-store");
  sensitive.add(initial.upload.token);
  assert.equal(accepted(await command("a", "objects/init", { ...metadata, clientCommandId: "init-original" })).objectId, initial.objectId, "init ACK loss preserves the original object");
  assert.equal((await command("a", "objects/init", metadata, { invalidSignature: true })).status, 401);
  assert.equal((await command("a", "objects/init", metadata, { tokenDeviceId: "device-b" })).status, 403);
  assert.equal((await command("a", "objects/init", { ...metadata, ownerUserId: "b" })).status, 400);
  assert.equal((await command("a", "objects/init", { ...metadata, ciphertextSize: 1024 ** 3 + 1 })).status, 400);
  const pendingStatus = accepted(await command("a", `objects/${initial.objectId}/status`, {}));
  assert.equal(pendingStatus.state, "uploading");
  assert.equal(pendingStatus.provider.state, "missing");
  assert.equal(pendingStatus.upload.objectKey, initial.upload.objectKey);
  providerUnavailable = true;
  const unknownStatus = await command("a", `objects/${initial.objectId}/status`, {});
  assert.equal(unknownStatus.status, 503);
  assert.equal(unknownStatus.body.retryable, true, "unreachable storage never becomes proof of missing ciphertext");
  providerUnavailable = false;
  assert.equal((await command("b", `objects/${initial.objectId}/status`, {})).status, 403, "a member is not the upload owner");
  assert.equal((await command("outsider", `objects/${initial.objectId}/status`, {})).status, 403);
  uploaded.set(initial.upload.objectKey, { size: 100, hash: metadata.ciphertextSha256 });
  uploaded.set(initial.upload.objectKey, { size: 99, hash: metadata.ciphertextSha256 });
  assert.equal((await command("a", `objects/${initial.objectId}/status`, {})).body.code, "COLLAB_OBJECT_VERIFICATION_FAILED");
  uploaded.set(initial.upload.objectKey, { size: 100, hash: metadata.ciphertextSha256 });
  const uploadedStatus = accepted(await command("a", `objects/${initial.objectId}/status`, {}));
  assert.equal(uploadedStatus.state, "uploading", "recovery inspection never commits completion implicitly");
  assert.deepEqual(uploadedStatus.provider, { state: "present", etag: "fake-etag" });
  const complete = { clientCommandId: "complete-original", etag: "fake-etag", ciphertextSize: 100, ciphertextSha256: metadata.ciphertextSha256 };
  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select id from stored_objects where id=$1 for update", [initial.objectId]);
    // The real complete preflight waits for this lock and raises native 55P03
    // after its configured 2s deadline, outside the command kernel retry loop.
    const timeout = await command("a", `objects/${initial.objectId}/complete`, complete);
    assert.equal(timeout.status, 503, "real PG lock timeout is a transient signed HTTP failure, not permanent bad input");
    assert.equal(timeout.body.code, "COLLAB_TRANSACTION_RETRY");
    assert.equal(timeout.body.retryable, true);
    assert.equal(timeout.headers["cache-control"], "no-store");
    assert.equal((await pool.query("select count(*)::int n from command_receipts where client_command_id=$1", [complete.clientCommandId])).rows[0].n, 0);
    assert.equal((await pool.query("select state from stored_objects where id=$1", [initial.objectId])).rows[0].state, "uploading");
  } finally { await blocker.query("rollback"); blocker.release(); }
  dropAckPath = `/api/collaboration/v1/objects/${initial.objectId}/complete`;
  assert.equal((await command("a", `objects/${initial.objectId}/complete`, complete)).status, 503);
  const completed = accepted(await command("a", `objects/${initial.objectId}/complete`, complete));
  assert.deepEqual(completed, committedAck);
  assert.equal(completed.state, "verified");
  const verifiedStatus = accepted(await command("a", `objects/${initial.objectId}/status`, {}));
  assert.equal(verifiedStatus.state, "verified");
  assert.equal(verifiedStatus.etag, "fake-etag");
  assert.equal(verifiedStatus.upload, undefined, "verified objects cannot issue new upload credentials");
  assert.deepEqual(accepted(await command("a", `objects/${initial.objectId}/complete`, complete)), completed);
  const send = { action: "send", conversationId, attachmentIds: [initial.objectId], attachmentPurpose: "attachment", clientCommandId: "send-original" };
  dropAckPath = "/api/collaboration/v1/messages";
  assert.equal((await command("a", "messages", send)).status, 503);
  const sent = accepted(await command("a", "messages", send));
  assert.deepEqual(sent, committedAck, "fault-injected loss between database COMMIT and HTTP ACK recovers the same message");
  assert.deepEqual(accepted(await command("a", "messages", send)), sent, "message ACK loss uses the real HTTP receipt without rebinding");
  assert.equal((await pool.query("select count(*)::int n from message_attachments where object_id=$1 and message_id=$2", [initial.objectId, sent.message.id])).rows[0].n, 1);
  assert.equal((await command("a", "messages", { ...send, attachmentIds: ["another-object"] })).body.code, "IDEMPOTENCY_KEY_REUSED");
  const history = accepted(await command("b", "messages", { action: "history", conversationId }));
  assert.deepEqual(history[0].attachmentIds, [initial.objectId]);
  const ticketResponse = await command("b", `objects/${initial.objectId}/download-ticket`, {});
  const ticket = accepted(ticketResponse);
  sensitive.add(ticket.url);
  assert.equal(ticket.dek, dek);
  assert.equal(ticketResponse.headers["cache-control"], "no-store");
  assert.ok(new Date(ticket.expiresAt).getTime() <= Date.now() + 300_000);
  assert.equal((await command("outsider", `objects/${initial.objectId}/download-ticket`, {})).status, 403);
  const sync = createCollaborationSyncService({ db });
  const page = await sync.syncAfterCursor({ userId: "a", deviceId: "device-a", afterCursor: 0 });
  for (const type of ["object.initiated", "object.verified", "message.created"]) assert.ok(page.events.some((event) => event.type === type), `signed object flow must not break durable sync: ${type}`);
  assert.ok(page.events.some((event) => event.type === "message.created" && event.payload.attachmentIds?.includes(initial.objectId)));
  const downloadPage = await sync.syncAfterCursor({ userId: "b", deviceId: "device-b", afterCursor: 0 });
  assert.ok(downloadPage.events.some((event) => event.type === "object.download_authorized"));
  await verifyTransferHttp({ app, keys, createAccessToken, stableStringify, sha256, uploaded, sensitive, conversationId, pool, dropAck: (value) => { dropAckPath = value; } });
  await pool.query("update organization_members set status='disabled' where user_id='b'");
  assert.equal((await command("b", `objects/${initial.objectId}/download-ticket`, {})).status, 403);
  assert.equal(accepted(await command("a", `objects/${initial.objectId}/revoke`, {})).state, "revoked");
  assert.equal((await command("a", `objects/${initial.objectId}/status`, {})).status, 403);
  assert.equal((await command("a", `objects/${initial.objectId}/download-ticket`, {})).status, 403);
  const orphan = accepted(await command("a", "objects/init", metadata));
  assert.equal(accepted(await command("a", `objects/${orphan.objectId}/abort`, {})).state, "aborted");
  const durable = JSON.stringify((await pool.query("select response_payload from command_receipts")).rows) + JSON.stringify((await pool.query("select payload from collaboration_events")).rows);
  for (const secret of sensitive) assert.equal(durable.includes(secret), false, "receipts and events contain no credentials");
  await app.close();
  app.log.info("logger-health-sentinel");
  assert.ok(logs.join("").includes("logger-health-sentinel"));
  for (const secret of sensitive) assert.equal(logs.join("").includes(secret), false, "real request/access/error logs contain no credentials");
  console.log("collaboration objects signed HTTP: actual routes, real PG send/replay/history/sync/revocation and real logger secrecy passed (fake Qiniu provider)");
} finally {
  await app.close(); await closeDb(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  process.chdir(oldCwd); await rmdir(emptyCwd);
}
