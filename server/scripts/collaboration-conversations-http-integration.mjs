import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { sql } from "kysely";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring.js");
const { createCollaborationClient } = require("../../src/main/collaboration/client.js");
const { createCollaborationService } = require("../../src/main/collaboration/service.js");

if (!process.env.DATABASE_URL) { console.log("collaboration conversations HTTP: skipped (DATABASE_URL is not configured)"); process.exit(0); }
const schema = `collab_conversations_http_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL); scoped.searchParams.set("options", `-c search_path=${schema}`);
scoped.searchParams.set("application_name", schema);
process.env.DATABASE_URL = scoped.href;
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.COLLABORATION_ENABLED = "true";
process.env.COLLABORATION_KILL_SWITCH = "false";
process.env.COLLABORATION_ROLLOUT_ORGANIZATIONS = "";
process.env.COLLAB_MESSAGE_KEK = crypto.randomBytes(32).toString("hex");
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { createAccessToken }, { stableStringify, sha256 }, { installDocOnlyCompilers }, { config }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/services/account-auth.js"), import("../src/services/security.js"), import("../src/openapi.js"), import("../src/config.js"),
]);
const app = Fastify({ logger: false });
installDocOnlyCompilers(app);
const [{ createCollaborationConversationProjectionService }, { createLockedMessageAuthorizer }, { createKyselyRepository }, { createCollaborationSyncService }] = await Promise.all([
  import("../src/services/collaboration/conversation-projection.js"), import("../src/services/collaboration/message-repository.js"), import("../src/services/collaboration/sync-repository.js"), import("../src/services/collaboration/sync-service.js"),
]);
let projectionBarrier = null, bootstrapInjection = null;
const authorize = createLockedMessageAuthorizer();
const syncRepository = createKyselyRepository(db);
const boundaries = ["getDeviceState", "getBootstrapProfile", "listBootstrapRelationships", "listBootstrapFriendRequests", "listBootstrapBlocks", "listBootstrapTeams", "listBootstrapTeamMembers", "listBootstrapConversations", "listBootstrapConversationMembers", "listBootstrapProfiles", "listBootstrapHistory", "getSyncState"];
const snapshotRepository = { ...syncRepository, ...Object.fromEntries(boundaries.map((method) => [method, async (...args) => {
  const result = await syncRepository[method](...args);
  if (bootstrapInjection) await bootstrapInjection(method);
  return result;
}])) };
const keys = new Map();
async function request(userId, endpoint, fields = {}, options = {}) {
  const deviceId = `device-${userId}`, pathname = `/api/collaboration/v1/${endpoint}`;
  const body = { deviceId, ...fields };
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
  const signature = crypto.sign(null, Buffer.from(stableStringify({ method: "POST", pathname, timestamp, nonce, bodyHash })), keys.get(userId).privateKey).toString("base64url");
  const response = await app.inject({ method: "POST", url: pathname, payload: body, headers: {
    authorization: `Bearer ${createAccessToken({ userId, deviceId: options.tokenDeviceId || deviceId, sessionId: `session-${userId}` })}`,
    "x-lily-device-id": deviceId, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce, "x-lily-body-sha256": bodyHash,
    "x-lily-signature": options.invalidSignature ? "invalid" : signature,
  } });
  return { status: response.statusCode, body: response.json() };
}
const command = (userId, fields, options) => request(userId, "conversations", { clientCommandId: crypto.randomUUID(), ...fields }, options);
const bootstrap = async (userId) => { const response = await request(userId, "bootstrap"); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
const get = (userId, conversationId) => request(userId, "conversations/get", { conversationId });
const create = async (userId, input) => { const response = await command(userId, { action: "create", ...input }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result.conversationId; };
try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key);
    create table devices(id text primary key);
    create table user_devices(user_id text references users(id),device_id text references devices(id),status text not null default 'active',primary key(user_id,device_id));
    create table user_profiles(user_id text primary key,lily_id text,display_name text,avatar_object_id text,discoverability text);
    create table organizations(id text primary key,name text,status text);
    create table organization_members(organization_id text references organizations(id),user_id text references users(id),role text,status text,joined_at timestamptz default now(),primary key(organization_id,user_id));
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
  `);
  for (const migration of ["033_collaboration_core.sql", "035_collaboration_bootstrap_completion.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "041_collaboration_reply_snapshots.sql"]) await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  for (const id of ["owner", "admin", "member", "invited", "disabled", "outsider"]) {
    const key = crypto.generateKeyPairSync("ed25519"); keys.set(id, key);
    await pool.query("insert into users values($1)", [id]);
    await pool.query("insert into devices values($1)", [`device-${id}`]);
    await pool.query("insert into user_devices(user_id,device_id) values($1,$2)", [id, `device-${id}`]);
    await pool.query("insert into user_profiles values($1,$2,$1,null,'contacts')", [id, `lily-${id}`]);
    await pool.query("insert into user_sessions values($1,$2,$3,null,now()+interval '1 hour')", [`session-${id}`, id, `device-${id}`]);
    await pool.query("insert into device_public_keys values($1,$2)", [`device-${id}`, key.publicKey.export({ type: "spki", format: "pem" })]);
  }
  await pool.query("insert into organizations values('org','Team','active'),('off','Disabled Team','disabled'); insert into organization_members(organization_id,user_id,role,status) values('org','owner','owner','active'),('org','admin','admin','active'),('org','member','member','active'),('org','invited','member','active'),('org','disabled','member','disabled'),('off','owner','owner','active')");
  registerCollaborationRoutes(app, { database: db, syncService: createCollaborationSyncService({ repository: snapshotRepository }), conversationProjectionService: createCollaborationConversationProjectionService({ database: db, authorize: async (input) => {
    const timeout = (await sql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout`.execute(input.trx)).rows[0];
    assert.deepEqual(timeout, { lock_timeout: "2s", statement_timeout: "8s" }, "projection read has bounded lock and statement waits");
    const result = await authorize(input);
    if (projectionBarrier) { projectionBarrier.entered.resolve(); await projectionBarrier.release.promise; }
    return result;
  } }) });
  await pool.query(`insert into friendships(user_low_id,user_high_id,status) values('admin','owner','active');
    insert into friend_requests(id,sender_user_id,receiver_user_id,status) values('incoming','outsider','owner','pending'),('outgoing','owner','disabled','pending'),('foreign','admin','member','pending');
    insert into user_blocks(blocker_user_id,blocked_user_id) values('owner','admin'),('outsider','owner');`);
  const social = await bootstrap('owner');
  assert.equal(social.directorySchemaVersion, 1, 'new bootstrap explicitly versions the complete social directory contract');
  assert.ok(Array.isArray(social.friendRequests), 'signed bootstrap includes the pending directory');
  assert.deepEqual(social.friendRequests.map((r) => r.id).sort(), ['incoming', 'outgoing']);
  assert.deepEqual(social.blocks.map((r) => r.blocked_user_id), ['admin'], 'bootstrap exposes ONLY caller-owned blocks');
  assert.ok(['owner','admin','outsider','disabled'].every((id) => social.profiles.some((p) => p.user_id === id)), 'friends, pending requests and own blocks have safe public profiles even without conversations');
  assert.equal(social.teamMembers.find((m) => m.user_id === 'admin').role, 'admin');
  const directoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-http-directory-'));
  const directoryKeyring = new LocalCollaborationKeyring({ filePath: path.join(directoryDir, 'keys'), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const directoryStore = new CollaborationStore({ dbPath: path.join(directoryDir, 'cache.db'), accountId: 'owner', keyring: directoryKeyring });
  try {
    directoryStore.replaceProjectionFromBootstrap(social);
    const directoryService = createCollaborationService({ openStore: () => ({ ok: true, store: directoryStore }) });
    const directory = await directoryService.getDirectory();
    assert.equal(directory.ok, true);
    assert.deepEqual(directory.contacts.map((p) => [p.userId,p.relationship,p.ownBlocked]), [['admin','friend',true],['disabled','outgoing',false],['outsider','incoming',false]]);
    assert.deepEqual(directory.teams.map((t) => t.id), ['org']);
    assert.deepEqual(directory.teams[0].members.map((m) => m.userId), ['admin','invited','member','owner']);
  } finally { directoryStore.close(); fs.rmSync(directoryDir, { recursive: true, force: true }); }
  const groupInput = { action: "create", scopeType: "personal", kind: "group", title: "Group", memberUserIds: ["member"] };
  const first = await command("owner", { ...groupInput, clientCommandId: "create-group" });
  assert.equal(first.status, 200, "the real signed HTTP route must create via the command kernel");
  const group = first.body.result.conversationId;
  assert.deepEqual((await command("owner", { ...groupInput, clientCommandId: "create-group" })).body.result, first.body.result);
  assert.equal((await command("owner", { ...groupInput, clientCommandId: "create-group", title: "Changed" })).body.code, "IDEMPOTENCY_KEY_REUSED");
  for (const bad of [{ actorUserId: "admin" }, { authorization: { role: "owner" } }, { title: "x".repeat(201) }, { memberUserIds: Array(501).fill("member") }, { organizationId: "forged-org" }]) {
    assert.equal((await command("owner", { ...groupInput, ...bad })).status, 400, "closed and bounded payloads reject unknown authority and malformed scope");
  }
  assert.equal((await command("owner", groupInput, { invalidSignature: true })).status, 401);
  assert.equal((await command("owner", groupInput, { tokenDeviceId: "device-member" })).status, 403);
  const publicInput = { scopeType: "organization", organizationId: "org", kind: "channel", visibility: "public", title: "Public" };
  assert.ok((await command("member", { action: "create", ...publicInput })).status >= 400);
  const pub = await create("admin", publicInput);
  const priv = await create("member", { ...publicInput, visibility: "private", title: "Private" });
  const direct = await create("owner", { scopeType: "organization", organizationId: "org", kind: "direct", memberUserIds: ["member"] });
  const send = async (userId, conversationId, bodyText) => { const response = await request(userId, "messages", { action: "send", clientCommandId: crypto.randomUUID(), conversationId, bodyText }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result.message; };
  const publicMessage = await send("member", pub, "public history without a cm");
  const beforeJoin = await send("member", priv, "before invite");
  const join = await command("member", { action: "member", conversationId: priv, targetUserId: "invited", operation: "add" });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  const afterJoin = await send("member", priv, "after invite");
  // A desktop with no channel projection consumes the actual joined event,
  // calls the signed get/history routes, then ACKs its fully materialized page.
  const joinCursor = Number((await pool.query("select cursor from user_sync_events where user_id='invited' and event_id=$1", [join.body.result.eventId])).rows[0].cursor);
  await pool.query("insert into device_sync_state(user_id,device_id,last_acked_cursor) values('invited','device-invited',$1)", [joinCursor - 1]);
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-http-discovery-"));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(localDir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const local = new CollaborationStore({ dbPath: ":memory:", accountId: "invited", keyring });
  local.replaceProjectionFromBootstrap({ watermark: joinCursor - 1, conversations: [] });
  const desktopCalls = [];
  const client = createCollaborationClient({ accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test-adapter" }) }, signDeviceRequest: async () => ({}), request: async ({ path: route, body }) => {
    const endpoint = route.split("/api/collaboration/v1/")[1]; desktopCalls.push(endpoint);
    const response = await request("invited", endpoint, body); // Real session + Ed25519 signed adapter above.
    return { ok: response.status === 200, status: response.status, json: response.body };
  } });
  const desktop = createCollaborationService({ openStore: () => ({ ok: true, store: local }), client, deviceId: "device-invited", realtimeOptions: { syncArgs: { deviceId: "device-invited" } } });
  try {
    await desktop.realtime.notifyAvailable();
    assert.deepEqual(desktopCalls, ["sync", "conversations/get", "messages", "ack"]);
    assert.equal(local.getConversation({ conversationId: priv }).scopeId, "team:org");
    assert.equal(local.getMessage({ conversationId: priv, messageId: afterJoin.id }).bodyText, "after invite");
    assert.equal(local.getMessage({ conversationId: priv, messageId: beforeJoin.id }), null, "first discovery cannot hydrate pre-membership history");
  } finally { desktop.stop(); fs.rmSync(localDir, { recursive: true, force: true }); }
  const memberView = await bootstrap("invited");
  assert.deepEqual(memberView.conversations.map((row) => row.id).sort(), [pub, priv].sort());
  assert.equal(memberView.conversations.find((row) => row.id === pub).visibility, "public");
  assert.equal(memberView.conversations.find((row) => row.id === pub).scopeId, "team:org");
  assert.ok(memberView.history.some((row) => row.id === publicMessage.id), "public history is readable without explicit cm");
  assert.ok(memberView.history.some((row) => row.id === afterJoin.id));
  assert.ok(!memberView.history.some((row) => row.id === beforeJoin.id), "private membership starts at the invitation sequence");
  assert.deepEqual(memberView.teamMembers.map((row) => row.user_id).sort(), ["admin", "invited", "member", "owner"]);
  for (const row of memberView.teamMembers) assert.deepEqual(Object.keys(row).sort(), ["organization_id", "user_id", "lily_id", "display_name", "avatar_object_id", "role"].sort(), "Team directory exposes public profile fields and role only");
  assert.deepEqual((await bootstrap("disabled")).conversations, []);
  assert.deepEqual((await bootstrap("disabled")).teamMembers, []);
  assert.deepEqual((await bootstrap("outsider")).teamMembers, []);
  assert.deepEqual((await bootstrap("owner")).teams.map((row) => row.id), ["org"], "disabled organizations are absent even when membership stays active");
  const discovered = await get("invited", priv);
  assert.equal(discovered.status, 200, JSON.stringify(discovered.body));
  assert.equal(discovered.body.result.conversation.id, priv);
  assert.equal(discovered.body.result.conversation.scopeId, "team:org");
  assert.ok(discovered.body.result.members.some((row) => row.user_id === "invited"));
  const deniedPrivate = await get("owner", priv);
  assert.equal(deniedPrivate.status, 403, "org owner has no implicit private read privilege");
  assert.equal(deniedPrivate.body.code, (await get("owner", "nonexistent")).body.code, "unknown and invisible conversations are indistinguishable");
  assert.equal((await get("outsider", direct)).status, 403);
  const baselineWatermark = Number((await pool.query("select next_cursor-1 as watermark from user_sync_state where user_id='owner'")).rows[0].watermark);
  const injectedMessages = [], injectedBoundaries = [];
  bootstrapInjection = async (boundary) => { injectedBoundaries.push(boundary); injectedMessages.push(await send("owner", pub, `during-${boundary}`)); };
  let racedBootstrap;
  try { racedBootstrap = await bootstrap("owner"); } finally { bootstrapInjection = null; }
  assert.deepEqual(injectedBoundaries, boundaries, "every actual SQL read boundary participates in the same snapshot");
  assert.equal(racedBootstrap.watermark, baselineWatermark);
  assert.ok(racedBootstrap.history.every((row) => !injectedMessages.some((message) => row.id === message.id)), "concurrent messages cannot creep into the old snapshot");
  const ack = await request("owner", "ack", { clientCommandId: "bootstrap-ack", cursor: racedBootstrap.watermark, bootstrapCompletionToken: racedBootstrap.bootstrapCompletionToken });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  const delta = await request("owner", "sync", { afterCursor: racedBootstrap.watermark });
  assert.equal(delta.body.events.length, boundaries.length);
  assert.deepEqual(delta.body.events.map((event) => event.cursor), boundaries.map((_, index) => baselineWatermark + index + 1), "every racing message remains in contiguous durable sync");
  assert.equal((await command("member", { action: "member", conversationId: priv, targetUserId: "invited", operation: "role", role: "admin" })).status, 200);
  projectionBarrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const activeRead = get("invited", priv);
  await projectionBarrier.entered.promise;
  const remove = command("member", { action: "member", conversationId: priv, targetUserId: "invited", operation: "remove" });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt++) waiting = Number((await admin.query("select count(*) as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like '%organizations%'", [schema])).rows[0].n) > 0;
    assert.equal(waiting, true, "member removal waits on the Organization lock held throughout get projection");
  } finally { projectionBarrier.release.resolve(); projectionBarrier = null; }
  assert.equal((await activeRead).status, 200, "read linearizes before waiting removal");
  assert.equal((await remove).status, 200);
  assert.equal((await get("invited", priv)).status, 403);
  assert.ok(!(await bootstrap("invited")).conversations.some((row) => row.id === priv));
  await pool.query("update conversation_members set status='removed' where conversation_id=$1 and user_id='owner'", [direct]);
  assert.equal((await get("owner", direct)).status, 403);
  assert.ok(!(await bootstrap("owner")).conversations.some((row) => row.id === direct), "Team direct still needs active explicit membership");
  await pool.query("update conversation_members set status='active' where conversation_id=$1 and user_id='owner'", [direct]);
  await pool.query("update organization_members set status='disabled' where user_id='member'");
  const revoked = await bootstrap("member");
  assert.deepEqual(revoked.conversations.map((row) => row.id), [group], "active cm cannot bypass disabled Team member but personal scope remains");
  assert.deepEqual(revoked.teamMembers, []);
  await pool.query("update organizations set status='disabled' where id='org'");
  assert.deepEqual((await bootstrap("owner")).conversations.map((row) => row.id), [group]);
  assert.equal((await get("owner", direct)).status, 403);
  config.collaborationRolloutOrganizations = ["not-eligible"];
  assert.equal((await command("owner", groupInput)).status, 404);
  config.collaborationRolloutOrganizations = [];
  config.collaborationKillSwitch = true;
  assert.equal((await command("owner", groupInput)).status, 503);
  assert.equal((await get("owner", group)).status, 503);
  config.collaborationKillSwitch = false;
  // Real desktop journal + signed routes: drop a committed HTTP response,
  // restart SQLite, and replay only the original durable command identity.
  const socialDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-http-social-"));
  const socialOptions = { dbPath: path.join(socialDir, "cache.db"), accountId: "owner", keyring: new LocalCollaborationKeyring({ filePath: path.join(socialDir, "keys"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } }) };
  let dropResponse = true;
  const socialCalls = [];
  const openSocial = () => {
    const store = new CollaborationStore(socialOptions);
    const client = createCollaborationClient({ accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test-adapter" }) }, signDeviceRequest: async () => ({}), request: async ({ path: route, body }) => {
      const endpoint = route.split("/api/collaboration/v1/")[1];
      const response = await request("owner", endpoint, body);
      if (["friends", "conversations"].includes(endpoint)) {
        socialCalls.push(body.clientCommandId);
        if (dropResponse && response.status === 200) { dropResponse = false; throw new Error("response dropped after commit"); }
      }
      return { ok: response.status === 200, status: response.status, json: response.body };
    } });
    return createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device-owner", realtimeEnabled: false });
  };
  let socialDesktop = openSocial();
  try {
    const pending = await socialDesktop.friend({ action: "request", lilyId: "lily-member" });
    assert.equal(pending.state, "confirming");
    socialDesktop.stop(); socialDesktop = openSocial();
    const confirmed = await socialDesktop.retrySocial({ clientCommandId: pending.clientCommandId });
    assert.equal(confirmed.state, "completed");
    assert.equal(socialCalls.at(-1), pending.clientCommandId);
    assert.equal((await pool.query("select count(*) as n from friend_requests where sender_user_id='owner' and receiver_user_id='member'")).rows[0].n, "1");
    const outgoing = socialDesktop.getDirectory().contacts.find((c) => c.userId === "member");
    assert.equal(outgoing.relationship, "outgoing");
    const accepted = await request("member", "friends", { action: "respond", requestId: outgoing.requestId, accept: true, clientCommandId: "desktop-accept" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    await socialDesktop.bootstrap();
    assert.equal(socialDesktop.openFriend({ peerUserId: "member" }).conversationId, accepted.body.conversationId);
    assert.equal((await socialDesktop.friend({ action: "block", peerUserId: "member" })).state, "completed");
    assert.equal(socialDesktop.openFriend({ peerUserId: "member" }).ok, false);
    assert.equal((await socialDesktop.friend({ action: "unblock", peerUserId: "member" })).state, "completed");
    assert.equal(socialDesktop.getDirectory().contacts.find((c) => c.userId === "member").ownBlocked, false);
    dropResponse = true;
    const created = await socialDesktop.conversation({ action: "create", scopeType: "personal", kind: "group", title: "Desktop durable group", memberUserIds: ["member"] });
    assert.equal(created.state, "confirming");
    socialDesktop.stop(); socialDesktop = openSocial();
    const recovered = await socialDesktop.retrySocial({ clientCommandId: created.clientCommandId });
    assert.equal(recovered.state, "completed");
    assert.equal(socialCalls.at(-1), created.clientCommandId);
    assert.equal((await pool.query("select count(*) as n from conversations where title='Desktop durable group'")).rows[0].n, "1");
    assert.equal((await socialDesktop.getConversationDetails({ conversationId: recovered.conversationId })).canManage, true);
  } finally { socialDesktop.stop(); fs.rmSync(socialDir, { recursive: true, force: true }); }
  await pool.query("update user_sessions set revoked_at=now() where user_id='owner'");
  assert.equal((await command("owner", groupInput)).body.code, "SESSION_EXPIRED");
  console.log("collaboration conversations HTTP: signed commands, authorization matrix, directory, history and discovery passed");
} finally { await app.close(); await closeDb(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
