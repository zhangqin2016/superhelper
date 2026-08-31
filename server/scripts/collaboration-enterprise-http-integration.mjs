import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { enterpriseDownloadFixture } from './collaboration-enterprise-download-fixture.mjs';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../../src/main/collaboration/collaboration-store.js');
const { LocalCollaborationKeyring } = require('../../src/main/collaboration/local-keyring.js');
const { createCollaborationClient } = require('../../src/main/collaboration/client.js');
const { createCollaborationService } = require('../../src/main/collaboration/service.js');
if (!process.env.DATABASE_URL) { console.log('enterprise collaboration HTTP: skipped (DATABASE_URL not configured)'); process.exit(0); }
const schema = `collab_enterprise_http_${crypto.randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set('options', `-c search_path=${schema}`);
scoped.searchParams.set('application_name', schema);
const cwd = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-enterprise-'));
process.chdir(temp); // Never let dotenv inspect real operator/repository secrets.
Object.assign(process.env, { DATABASE_URL: scoped.href, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_TOKEN: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: 'test-admin@example.invalid', COLLABORATION_ENABLED: 'true', COLLABORATION_KILL_SWITCH: 'false', COLLABORATION_ROLLOUT_ORGANIZATIONS: '', COLLAB_MESSAGE_KEK: crypto.randomBytes(32).toString('hex'), COLLAB_MESSAGE_KEK_VERSION: 'v1' });
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { registerPublicEnterpriseRoutes }, { adminRoutes }, auth, security, { installDocOnlyCompilers }, { createLockedMessageAuthorizer }] = await Promise.all([
  import('../src/db.js'), import('../src/routes/public/collaboration.js'), import('../src/routes/public/enterprise.js'), import('../src/routes/admin.js'), import('../src/services/account-auth.js'), import('../src/services/security.js'), import('../src/openapi.js'), import('../src/services/collaboration/message-repository.js'),
]);
const app = Fastify({ logger: false }); installDocOnlyCompilers(app);
const downloads = enterpriseDownloadFixture(db, pool);
const keys = new Map();
let invalidateSession = false, messageBarrier = null;
const token = (userId) => auth.createAccessToken({ userId, sessionId: `session-${userId}`, deviceId: `device-${userId}` });
async function enterprise(method, suffix, payload, { actor = 'owner', web = false, platform = false } = {}) {
  const headers = platform ? web ? { cookie: `lily_admin_session=${security.createAdminSessionToken()}` } : { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } : web ? { cookie: `lily_user_session=${auth.createWebSessionToken({ userId: actor, sessionId: `session-${actor}` })}` } : { authorization: `Bearer ${token(actor)}` };
  const res = await app.inject({ method, url: `/api/${platform ? 'admin/' : ''}enterprise/organizations/${suffix}`, ...(payload === undefined ? {} : { payload }), headers });
  return { status: res.statusCode, body: res.json() };
}
async function signed(userId, endpoint, fields = {}) {
  const deviceId = `device-${userId}`, pathname = `/api/collaboration/v1/${endpoint}`, body = { deviceId, ...fields };
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = security.sha256(security.stableStringify(body));
  const signature = crypto.sign(null, Buffer.from(security.stableStringify({ method: 'POST', pathname, timestamp, nonce, bodyHash })), keys.get(userId).privateKey).toString('base64url');
  const res = await app.inject({ method: 'POST', url: pathname, payload: body, headers: { authorization: `Bearer ${token(userId)}`, 'x-lily-device-id': deviceId, 'x-lily-timestamp': timestamp, 'x-lily-nonce': nonce, 'x-lily-body-sha256': bodyHash, 'x-lily-signature': signature } });
  return { status: res.statusCode, body: res.json() };
}
const expectOK = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const events = async () => (await pool.query('select * from collaboration_events order by created_at,id')).rows;
const counts = async () => (await pool.query('select (select count(*) from collaboration_events)::int as events,(select count(*) from user_sync_events)::int as sync,(select count(*) from collaboration_realtime_outbox)::int as outbox,(select sum(next_cursor)::int from user_sync_state) as cursors')).rows[0];
async function waitForOrganizationLock() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const waiting = await admin.query("select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like '%organizations%for update%'", [schema]);
    if (waiting.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No enterprise request waited on the shared organization lock');
}
let desktop;
try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`create table users(id text primary key,phone_e164 text);
    create table devices(id text primary key);
    create table user_devices(user_id text references users(id),device_id text references devices(id),status text not null default 'active',primary key(user_id,device_id));
    create table user_profiles(user_id text primary key,lily_id text,display_name text,avatar_object_id text,discoverability text);
    create table organizations(id text primary key,name text,status text,plan text default 'standard',created_at timestamptz default now(),updated_at timestamptz default now());
    create table organization_members(organization_id text references organizations(id),user_id text references users(id),role text,status text,quota bigint,joined_at timestamptz default now(),primary key(organization_id,user_id));
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
    create table audit_logs(actor text,action text,target_type text,target_id text,ip text,user_agent text,metadata jsonb);`);
  for (const file of ['033_collaboration_core.sql', '035_collaboration_bootstrap_completion.sql', '037_collaboration_relationship_events.sql', '038_collaboration_conversations.sql', '039_collaboration_objects.sql', '040_collaboration_trusted_actors.sql']) {
    const url = new URL(`../migrations/${file}`, import.meta.url);
    if (fs.existsSync(url)) await pool.query(fs.readFileSync(url, 'utf8'));
  }
  for (const userId of ['owner', 'admin', 'member', 'extra', 'outsider']) {
    const key = crypto.generateKeyPairSync('ed25519'); keys.set(userId, key);
    await pool.query('insert into users values($1,$2)', [userId, `+8613800${userId}`]);
    await pool.query('insert into devices values($1)', [`device-${userId}`]);
    await pool.query('insert into user_devices(user_id,device_id) values($1,$2)', [userId, `device-${userId}`]);
    await pool.query("insert into user_profiles values($1,$2,$1,null,'contacts')", [userId, `lily-${userId}`]);
    await pool.query("insert into user_sessions values($1,$2,$3,null,now()+interval '1 hour')", [`session-${userId}`, userId, `device-${userId}`]);
    await pool.query('insert into device_public_keys values($1,$2)', [`device-${userId}`, key.publicKey.export({ type: 'spki', format: 'pem' })]);
    await pool.query('insert into device_sync_state(user_id,device_id) values($1,$2)', [userId, `device-${userId}`]);
  }
  await pool.query("insert into organizations(id,name,status) values('org','Team','active'); insert into organization_members(organization_id,user_id,role,status) values('org','owner','owner','active'),('org','admin','admin','active'),('org','member','member','active')");
  await app.register(cookie);
  registerPublicEnterpriseRoutes(app);
  await adminRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (invalidateSession && req.url.startsWith('/api/enterprise/')) { invalidateSession = false; await pool.query("update user_sessions set revoked_at=now() where id='session-owner'"); }
  });
  const authorize = createLockedMessageAuthorizer();
  registerCollaborationRoutes(app, { database: db, objectService: downloads.service, authorizeMessage: async (input) => {
    const result = await authorize(input);
    if (messageBarrier && result.ok) { messageBarrier.entered.resolve(); await messageBarrier.release.promise; }
    return result;
  } });
  const conv = expectOK(await signed('owner', 'conversations', { clientCommandId: crypto.randomUUID(), action: 'create', scopeType: 'organization', organizationId: 'org', kind: 'channel', visibility: 'public', title: 'Team' })).result.conversationId;
  const send = (userId = 'member') => signed(userId, 'messages', { clientCommandId: crypto.randomUUID(), action: 'send', conversationId: conv, bodyText: 'Team message' });
  const seedMessage = expectOK(await send()).result.message;
  const objectId = await downloads.seed(conv, seedMessage.id);
  const download = () => signed('member', `objects/${objectId}/download-ticket`, { clientCommandId: crypto.randomUUID() });
  expectOK(await download());
  const initial = expectOK(await signed('member', 'bootstrap'));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(temp, 'keys'), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const store = new CollaborationStore({ dbPath: path.join(temp, 'desktop.db'), accountId: 'member', keyring });
  store.replaceProjectionFromBootstrap(initial);
  const oldSecret = keyring.encrypt({ accountId: 'member', scopeId: 'team:org', recordId: 'proof', plaintext: 'cached plaintext' });
  const client = createCollaborationClient({ accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: 'adapter' }) }, signDeviceRequest: async () => ({}), request: async ({ path: route, body }) => {
    const res = await signed('member', route.split('/api/collaboration/v1/')[1], body);
    return { ok: res.status === 200, status: res.status, json: res.body };
  } });
  desktop = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: 'device-member', realtimeOptions: { syncArgs: { deviceId: 'device-member' } } });
  const before = await events();
  expectOK(await enterprise('PATCH', 'org/members/member', { status: 'disabled' }, { web: true }));
  const committed = (await events()).slice(before.length);
  assert.ok(committed.some((event) => event.type === 'scope.revoked'), 'real enterprise disable must atomically commit a durable scope revocation, not only a DB flag');
  const revoke = committed.find((event) => event.type === 'scope.revoked');
  assert.deepEqual(revoke.payload, { scopeType: 'organization', organizationId: 'org', userId: 'member', reason: 'membership-disabled' });
  assert.equal(revoke.actor_source, 'enterprise-web'); assert.equal(revoke.actor_user_id, 'owner'); assert.equal(revoke.actor_device_id, null);
  assert.deepEqual((await pool.query('select user_id from user_sync_events where event_id=$1 order by user_id', [revoke.id])).rows.map((r) => r.user_id), ['member']);
  await desktop.realtime.notifyAvailable();
  assert.equal(store.getConversation({ conversationId: conv }), null);
  assert.deepEqual(desktop.getDirectory().teams, []);
  assert.throws(() => keyring.decrypt({ accountId: 'member', scopeId: 'team:org', recordId: 'proof', envelope: oldSecret }), { code: 'COLLAB_LOCAL_KEY_UNAVAILABLE' });
  assert.equal((await send()).status, 403);
  assert.equal((await download()).status, 403, 'member revocation denies fresh download capability issuance');
  const afterDisable = await counts();
  expectOK(await enterprise('PATCH', 'org/members/member', { status: 'disabled' }));
  assert.deepEqual(await counts(), afterDisable, 'repeated no-op disable must not allocate events/cursors/outbox');
  expectOK(await enterprise('PATCH', 'org/members/member', { status: 'active', role: 'admin', memberQuota: 7 }));
  await desktop.realtime.notifyAvailable();
  assert.equal(desktop.getDirectory().teams[0].role, 'admin', 'reactivation refreshes via real authorized bootstrap');
  assert.ok(store.getConversation({ conversationId: conv }));
  expectOK(await send());
  expectOK(await enterprise('POST', 'org/members', { userId: 'extra' }));
  assert.equal((await events()).at(-1).type, 'directory.changed');
  assert.equal((await enterprise('POST', 'org/members', { userId: 'extra' })).status, 409);
  expectOK(await enterprise('DELETE', 'org/members/extra'));
  const removed = await counts();
  assert.equal((await enterprise('DELETE', 'org/members/extra')).status, 404);
  assert.deepEqual(await counts(), removed);
  assert.equal((await enterprise('PATCH', 'org/members/owner', { status: 'disabled' }, { actor: 'admin' })).body.code, 'ORG_OWNER_IMMUTABLE');
  assert.equal((await enterprise('PATCH', 'org/members/owner', { role: 'member' })).body.code, 'ORG_OWNER_IMMUTABLE');
  assert.equal((await enterprise('POST', 'org/members', { userId: 'extra', role: 'owner' }, { actor: 'admin' })).body.code, 'ORG_PROMOTE_FORBIDDEN');
  const roleBlocker = await pool.connect();
  try {
    await roleBlocker.query('begin'); await roleBlocker.query("select id from organizations where id='org' for update");
    const staleAdmin = enterprise('PATCH', 'org/members/member', { status: 'disabled' }, { actor: 'admin' });
    await waitForOrganizationLock();
    await roleBlocker.query("update organization_members set role='member' where organization_id='org' and user_id='admin'");
    await roleBlocker.query('commit');
    assert.equal((await staleAdmin).body.code, 'ORG_FORBIDDEN', 'authorization must use the role committed while waiting, not preHandler state');
  } finally { await roleBlocker.query('rollback'); roleBlocker.release(); }
  expectOK(await enterprise('PATCH', 'org/members/admin', { role: 'admin' }));
  invalidateSession = true;
  assert.equal((await enterprise('PATCH', 'org/members/member', { status: 'disabled' })).status, 401, 'session revoked after preHandler must fail inside the mutation transaction');
  await pool.query("update user_sessions set revoked_at=null where id='session-owner'");
  const { config } = await import('../src/config.js');
  const authBlocker = await pool.connect();
  try {
    await authBlocker.query('begin'); await authBlocker.query("select id from organizations where id='org' for update");
    const stalePlatform = enterprise('PATCH', 'org', { status: 'disabled' }, { platform: true });
    await waitForOrganizationLock(); config.adminToken = 'rotated-test-admin-token';
    await authBlocker.query('commit');
    assert.equal((await stalePlatform).status, 401, 'admin credentials are rechecked after acquiring current scope locks');
  } finally { config.adminToken = process.env.ADMIN_TOKEN; await authBlocker.query('rollback'); authBlocker.release(); }
  const rollbackBefore = await counts();
  await pool.query("create function reject_outbox() returns trigger language plpgsql as $$ begin if new.user_id='owner' then raise exception 'injected later-recipient outbox failure'; end if; return new; end $$; create trigger reject_outbox before insert on collaboration_realtime_outbox for each row execute function reject_outbox()");
  assert.equal((await enterprise('PATCH', 'org', { status: 'disabled' })).status, 500);
  assert.equal((await pool.query("select status from organizations where id='org'")).rows[0].status, 'active');
  assert.deepEqual(await counts(), rollbackBefore, 'fanout failure rolls back org mutation, every event, cursor and outbox');
  for (const [method, suffix, payload, options] of [
    ['PATCH', 'org/members/member', { status: 'disabled' }],
    ['PATCH', 'org/members/member', { role: 'member' }],
    ['DELETE', 'org/members/member'],
    ['POST', 'org/members', { userId: 'extra' }],
    ['PATCH', 'org', { status: 'disabled' }, { platform: true }],
  ]) {
    assert.equal((await enterprise(method, suffix, payload, options)).status, 500, `${method} ${suffix} must fail closed on durable fanout failure`);
    assert.deepEqual(await counts(), rollbackBefore);
    assert.equal((await pool.query("select status from organizations where id='org'")).rows[0].status, 'active');
    assert.deepEqual((await pool.query("select role,status from organization_members where organization_id='org' and user_id='member'")).rows[0], { role: 'admin', status: 'active' });
    assert.equal((await pool.query("select count(*)::int as n from organization_members where organization_id='org' and user_id='extra'")).rows[0].n, 0);
  }
  await pool.query('drop trigger reject_outbox on collaboration_realtime_outbox; drop function reject_outbox()');
  await pool.query("create function reject_directory() returns trigger language plpgsql as $$ begin if new.type='directory.changed' then raise exception 'injected event failure'; end if; return new; end $$; create trigger reject_directory before insert on collaboration_events for each row execute function reject_directory()");
  assert.equal((await enterprise('PATCH', 'org/members/member', { status: 'disabled' })).status, 500);
  assert.deepEqual(await counts(), rollbackBefore, 'second event failure rolls back the earlier revocation event and membership update');
  await pool.query('drop trigger reject_directory on collaboration_events; drop function reject_directory()');
  messageBarrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const pendingSend = send(); await messageBarrier.entered.promise;
  const pendingDisable = enterprise('PATCH', 'org', { status: 'disabled' }, { platform: true });
  await waitForOrganizationLock();
  messageBarrier.release.resolve(); messageBarrier = null;
  const sent = expectOK(await pendingSend); expectOK(await pendingDisable);
  const ordered = (await pool.query("select e.type,s.cursor from user_sync_events s join collaboration_events e on e.id=s.event_id where s.user_id='member' order by s.cursor")).rows;
  assert.ok(ordered.findIndex((r) => r.type === 'scope.revoked') >= 0);
  assert.equal(ordered.at(-1).type, 'scope.revoked', 'send holding the organization lock commits before admin revocation');
  assert.ok(sent.result.message.id);
  assert.equal((await send()).status, 403, 'revocation-committed-first send denies');
  assert.equal((await download()).status, 403, 'organization revocation-committed-first download denies');
  const off = await counts(); expectOK(await enterprise('PATCH', 'org', { status: 'disabled' }, { platform: true })); assert.deepEqual(await counts(), off);
  const adminEvent = (await events()).filter((e) => e.actor_source === 'platform-admin').at(-1);
  assert.equal(adminEvent.actor_user_id, null); assert.equal(adminEvent.actor_device_id, null); assert.equal(adminEvent.audit_actor, process.env.ADMIN_EMAIL);
  expectOK(await enterprise('PATCH', 'org', { status: 'active' }, { web: true }));
  await desktop.realtime.notifyAvailable(); assert.equal(desktop.getDirectory().teams[0].id, 'org');
  const downloadBarrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  downloads.hold(downloadBarrier);
  const pendingDownload = download(); await downloadBarrier.entered.promise;
  const memberRemoval = enterprise('DELETE', 'org/members/member');
  await waitForOrganizationLock();
  downloadBarrier.release.resolve(); downloads.hold(null);
  expectOK(await pendingDownload); expectOK(await memberRemoval);
  assert.equal((await download()).status, 403, 'download holding the org lock completes first; every later download denies');
  await desktop.realtime.notifyAvailable(); assert.equal(store.getConversation({ conversationId: conv }), null);
  expectOK(await enterprise('POST', 'org/members', { phoneE164: '+8613800member' }));
  await desktop.realtime.notifyAvailable(); assert.equal(desktop.getDirectory().teams[0].role, 'member');
  expectOK(await enterprise('PATCH', 'org', { status: 'disabled' }, { platform: true, web: true }));
  await desktop.realtime.notifyAvailable(); assert.equal(store.getConversation({ conversationId: conv }), null, 'admin organization revoke reaches the actual desktop and purges Team cache');
  expectOK(await enterprise('PATCH', 'org', { status: 'active' }, { platform: true, web: true }));
  await assert.rejects(pool.query("insert into collaboration_events(id,seq,type,actor_user_id,client_command_id) values('fake-device',1,'scope.revoked','owner','fake')"), (e) => e.code === '23514');
  await assert.rejects(pool.query("insert into collaboration_events(id,seq,type,actor_source,actor_user_id,actor_device_id,client_command_id) values('fake-admin',1,'scope.revoked','platform-admin','owner','device-owner','fake')"), (e) => e.code === '23514');
  await assert.rejects(pool.query("insert into collaboration_events(id,seq,type,actor_user_id,actor_device_id,client_command_id) values('wrong-device',1,'scope.revoked','owner','device-member','fake')"), (e) => e.code === '23503');
  await assert.rejects(pool.query("insert into collaboration_events(id,seq,type,actor_source,client_command_id) values('no-admin-label',1,'scope.revoked','platform-admin','fake')"), (e) => e.code === '23514');
  await assert.rejects(pool.query("insert into collaboration_events(id,seq,type,actor_source,actor_user_id,client_command_id) values('no-device-message',1,'message.created','enterprise-web','owner','fake')"), (e) => e.code === '23514');
  // Opposite target order across two organizations with the same recipient
  // union must not acquire user cursors in target-first order and deadlock.
  for (let n = 0; n < 3; n++) {
    const left = `left-${n}`, right = `right-${n}`;
    await pool.query("insert into organizations(id,name,status) values($1,'Left','active'),($2,'Right','active')", [left, right]);
    await pool.query("insert into organization_members(organization_id,user_id,role,status) values($1,'owner','owner','active'),($1,'admin','member','active'),($1,'member','member','active'),($2,'admin','owner','active'),($2,'owner','member','active'),($2,'member','member','active')", [left, right]);
    const results = await Promise.all([enterprise('DELETE', `${left}/members/admin`), enterprise('DELETE', `${right}/members/owner`, undefined, { actor: 'admin' })]);
    results.forEach(expectOK);
  }
  assert.equal((await pool.query("select count(*)::int as n from user_sync_events s left join collaboration_realtime_outbox o on o.user_id=s.user_id and o.max_cursor=s.cursor where o.id is null")).rows[0].n, 0);
  console.log('enterprise collaboration HTTP: real dual-auth/admin routes, durable PG revocation -> SQLite/key purge, roster bootstrap, noop, session/role recheck, multi-recipient rollback, send/download lock ordering and actor invariants passed');
} finally {
  desktop?.stop(); await app.close(); await closeDb();
  await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true });
}
