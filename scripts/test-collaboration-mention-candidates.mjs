import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createCollaborationService } = require('../src/main/collaboration/service');
const { createCollaborationIpc } = require('../src/main/ipc-collaboration');
const { normalizeProjection } = require('../src/main/collaboration/conversation-hydration');
const { messageMetadata } = require('../src/main/collaboration/message-intent');
const { removeConversationRows, revokeScope } = require('../src/main/collaboration/access-revocation');
const candidate = (userId) => ({ userId, lilyId: '', displayName: '', avatarObjectId: null });
function projection(conversationId = 'c', visibility = 'private') {
  return { conversation: { id: conversationId, scopeType: 'organization', organizationId: 'org', kind: 'channel', visibility, title: 'Team' },
    members: ['alice', 'bob'].map((userId) => ({ conversationId, userId, status: 'active', role: userId === 'alice' ? 'owner' : 'member', joinedSeq: 0 })), profiles: [],
    mentionCandidates: { status: 'complete', items: ['alice', 'bob'].map(candidate) } };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-candidates-'));
  const store = new CollaborationStore({ accountId: 'alice', dbPath: path.join(dir, 'db'), keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } }) });
  let value = projection(), calls = 0, clock = 1000;
  const client = { getConversationProjection: async () => { calls++; return structuredClone(value); } };
  const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: 'device', realtimeEnabled: false, mentionCandidateClock: () => clock });
  const handlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, service, client, handlers, get calls() { return calls; }, set value(v) { value = v; }, tick(ms) { clock += ms; },
    call: (name, payload = { conversationId: 'c' }) => handlers.get(`collaboration:${name}`)?.(null, payload) };
}

test('candidate projection is separate, complete, minimal and legacy unknown', () => {
  const value = projection('c', 'public');
  value.mentionCandidates.items.push(candidate('without-channel-row'));
  assert.deepEqual(normalizeProjection(value, 'c', 'alice').mentionCandidates, value.mentionCandidates);
  assert.equal(normalizeProjection(value, 'c', 'alice').members.length, 2);
  delete value.mentionCandidates;
  assert.deepEqual(normalizeProjection(value, 'c', 'alice').mentionCandidates, { status: 'unknown', items: [] });
});

for (const variant of ['partial', 'null', 'duplicates', 'outside-private', 'bad-id', 'bad-lily-id', 'bad-name', 'private-fields', 'extra-field', '1001']) test(`candidate boundary rejects ${variant}`, () => {
  const value = projection();
  if (variant === 'partial') value.mentionCandidates.status = 'partial';
  if (variant === 'null') value.mentionCandidates = null;
  if (variant === 'duplicates') value.mentionCandidates.items.push(candidate('bob'));
  if (variant === 'outside-private') value.mentionCandidates.items.push(candidate('other'));
  if (variant === 'bad-id') value.mentionCandidates.items[0].userId = 'bad\nid';
  if (variant === 'bad-lily-id') value.mentionCandidates.items[0].lilyId = 'bad\nid';
  if (variant === 'bad-name') value.mentionCandidates.items[0].displayName = {};
  if (variant === 'private-fields') value.mentionCandidates.items[0].email = 'private@example.test';
  if (variant === 'extra-field') value.mentionCandidates.cursor = 'more';
  if (variant === '1001') { value.conversation.visibility = 'public'; value.mentionCandidates.items = Array.from({ length: 1001 }, (_, i) => candidate(`u${i}`)); }
  assert.throws(() => normalizeProjection(value, 'c', 'alice'), { code: 'COLLAB_MENTION_CANDIDATES_INVALID' });
});

test('exactly 1000 public candidates are accepted; non-public direct/group stay explicit', () => {
  const value = projection('c', 'public');
  value.mentionCandidates.items = Array.from({ length: 1000 }, (_, i) => candidate(`u${i}`));
  assert.equal(normalizeProjection(value, 'c', 'alice').mentionCandidates.items.length, 1000);
  for (const scope of ['personal', 'organization']) {
    const direct = projection(); direct.conversation.kind = 'direct'; delete direct.conversation.visibility;
    direct.conversation.scopeType = scope; if (scope === 'personal') delete direct.conversation.organizationId;
    direct.mentionCandidates.items.push(candidate('outside'));
    assert.throws(() => normalizeProjection(direct, 'c', 'alice'), { code: 'COLLAB_MENTION_CANDIDATES_INVALID' });
  }
});

for (const field of ['userId', 'lilyId', 'avatarObjectId']) test(`candidate ${field} uses the send-intent identifier contract`, () => {
  for (const value of ['bad id', 'bad\tid', 'bad\u00a0id', 'bad\u0080id', 'bad\u0085id', 'bad\u009fid']) {
    const view = projection('c', 'public'); view.mentionCandidates.items[0][field] = value;
    assert.throws(() => normalizeProjection(view, 'c', 'alice'), { code: 'COLLAB_MENTION_CANDIDATES_INVALID' }, JSON.stringify(value));
    assert.throws(() => messageMetadata({ mentionUserIds: [value] }), { code: 'COLLABORATION_INVALID_INPUT' });
  }
});

test('accepted candidate identifiers enter the immutable send intent without reinterpretation', () => {
  const value = projection('c', 'public');
  value.mentionCandidates.items = ['user:one', 'user_two-2', '用户三'].map(candidate);
  const normalized = normalizeProjection(value, 'c', 'alice');
  const mentionUserIds = normalized.mentionCandidates.items.map((item) => item.userId);
  assert.deepEqual(messageMetadata({ mentionUserIds }).mentionUserIds, mentionUserIds);
  assert.equal(normalized.mentionCandidates.items[0].lilyId, '');
  assert.equal(normalized.mentionCandidates.items[0].avatarObjectId, null);
});

test('fresh details seed candidate-only cache, never cache management permissions', async (t) => {
  const f = fixture(t);
  const details = await f.call('get-conversation-details');
  assert.deepEqual(details.mentionCandidates, projection().mentionCandidates);
  assert.equal(details.canManage, true);
  const hit = await f.call('get-mention-candidates');
  assert.deepEqual(hit, { ok: true, conversationId: 'c', mentionCandidates: projection().mentionCandidates });
  hit.mentionCandidates.items[0].displayName = 'mutated';
  assert.equal((await f.call('get-mention-candidates')).mentionCandidates.items[0].displayName, '');
  assert.equal(f.calls, 1);
  const changed = projection(); changed.members[0].role = 'member'; f.value = changed;
  assert.equal((await f.call('get-conversation-details')).canManage, false);
  assert.equal(f.calls, 2);
  f.tick(30001);
  assert.equal((await f.call('get-mention-candidates')).ok, true);
  assert.equal(f.calls, 3);
  assert.equal(f.store.db.get("SELECT COUNT(*) n FROM profiles WHERE user_id NOT IN ('alice','bob')").n, 0);
});

test('legacy candidate unknown never falls back to full Team roster or caches permission hints', async (t) => {
  const f = fixture(t), value = projection('c', 'public'); delete value.mentionCandidates; f.value = value;
  f.store.replaceProjectionFromBootstrap({ conversations: [value.conversation], members: value.members, teams: [{ id: 'org', status: 'active' }], teamMembers: [{ organizationId: 'org', userId: 'outsider', displayName: 'Never infer' }] });
  assert.deepEqual((await f.call('get-mention-candidates')).mentionCandidates, { status: 'unknown', items: [] });
  await f.call('get-mention-candidates'); assert.equal(f.calls, 2);
});

for (const variant of ['cursor', 'membership', 'directory', 'bootstrap', 'pending-generation']) test(`cache invalidates on ${variant}`, async (t) => {
  const f = fixture(t); await f.call('get-mention-candidates');
  if (variant === 'cursor') f.service.syncEngine.applyPage({ fromCursor: 0, toCursor: 1, events: [{ id: 'directory-1', cursor: 1, type: 'directory.changed', payload: {} }] });
  if (variant === 'membership') f.store.db.run("UPDATE conversation_members SET role='member' WHERE user_id='alice'");
  if (variant === 'directory') f.store.db.run("INSERT INTO profiles(account_id,user_id,display_name,updated_at) VALUES('alice','bob','Changed',1)");
  if (variant === 'bootstrap') f.store.replaceProjectionFromBootstrap({ conversations: [projection().conversation], members: projection().members });
  if (variant === 'pending-generation') f.store.db.run("INSERT INTO conversation_hydration(account_id,conversation_id,created_at,generation) VALUES('alice','c',1,'new')");
  await f.call('get-mention-candidates'); assert.equal(f.calls, 2);
});

for (const variant of ['conversation', 'team']) test(`cached candidates are inaccessible after ${variant} revocation`, async (t) => {
  const f = fixture(t); await f.call('get-mention-candidates');
  if (variant === 'conversation') removeConversationRows(f.store, 'c', 'team:org'); else revokeScope(f.store, 'team:org');
  assert.equal((await f.call('get-mention-candidates')).code, 'COLLAB_ACCESS_REVOKED');
  assert.equal(f.calls, 1, 'cache read cannot regrant current revocation');
});

for (const outcome of ['resolve', 'reject']) for (const change of ['bootstrap', 'directory', 'remove-regrant']) test(`late details ${outcome} cannot alter new ${change} epoch`, async (t) => {
  const f = fixture(t), entered = Promise.withResolvers(), pending = Promise.withResolvers();
  f.client.getConversationProjection = async () => { entered.resolve(); return pending.promise; };
  const old = f.call('get-conversation-details'); await entered.promise;
  const fresh = projection(); fresh.members[0].role = 'member';
  if (change === 'remove-regrant') removeConversationRows(f.store, 'c', 'team:org');
  f.store.replaceProjectionFromBootstrap({ conversations: [fresh.conversation], members: fresh.members });
  if (change === 'directory') f.store.db.run("INSERT INTO profiles(account_id,user_id,display_name,updated_at) VALUES('alice','other','New epoch',1)");
  if (outcome === 'resolve') pending.resolve(projection()); else pending.reject(Object.assign(new Error('old denial'), { code: 'COLLAB_CONVERSATION_UNAVAILABLE' }));
  assert.equal((await old).code, 'COLLAB_CONVERSATION_STALE');
  assert.equal(f.store.listConversationMembers({ conversationId: 'c' }).find((m) => m.userId === 'alice')?.role, 'member');
  assert.ok(f.store.getConversation({ conversationId: 'c' }));
});

test('candidate IPC rejects authority input and strips noncandidate data; stop fences a late result', async (t) => {
  const f = fixture(t);
  assert.equal(typeof f.handlers.get('collaboration:get-mention-candidates'), 'function');
  for (const payload of [{ conversationId: 'c', scopeId: 'team:forged' }, { conversationId: 'c', accountId: 'other' }, { conversationId: 'c', mentionCandidates: {} }]) {
    assert.equal((await f.call('get-mention-candidates', payload)).code, 'COLLABORATION_INVALID_INPUT');
  }
  const entered = Promise.withResolvers(), pending = Promise.withResolvers();
  f.client.getConversationProjection = async () => { entered.resolve(); return pending.promise; };
  const result = f.call('get-mention-candidates'); await entered.promise; f.service.stop(); pending.resolve(projection());
  assert.equal((await result).code, 'COLLABORATION_STOPPED');
});

test('ordinary typing does not stale pending details or invalidate cached candidates', async (t) => {
  const f = fixture(t);
  await f.call('get-conversation-details');
  const entered = Promise.withResolvers(), pending = Promise.withResolvers();
  f.client.getConversationProjection = async () => { entered.resolve(); return pending.promise; };
  const details = f.call('get-conversation-details'); await entered.promise;
  f.service.saveDraft({ conversationId: 'c', text: '@b', mentionUserIds: [] });
  pending.resolve(projection());
  assert.equal((await details).ok, true);
  f.client.getConversationProjection = async () => { throw new Error('should use cache after typing'); };
  f.service.saveDraft({ conversationId: 'c', text: '@bo', mentionUserIds: [] });
  f.store.hydrateAuthorizedHistory({ conversationId: 'c', messages: [{ id: 'history-only', seq: 1, bodyText: 'local cache write' }], completeCheckpoint: false });
  assert.deepEqual((await f.call('get-mention-candidates')).mentionCandidates, projection().mentionCandidates);
});

test('candidate-only LRU is bounded at 32, TTL-limited and account/clear fenced', async (t) => {
  const f = fixture(t);
  const { createMentionCandidateCache } = require('../src/main/collaboration/mention-candidate-cache');
  let clock = 100;
  const cache = createMentionCandidateCache({ store: f.store, now: () => clock });
  f.store.replaceProjectionFromBootstrap({ conversations: Array.from({ length: 33 }, (_, i) => projection(`c${i}`).conversation) });
  for (let i = 0; i < 32; i++) cache.put(`c${i}`, projection().mentionCandidates);
  assert.ok(cache.get('c0')); cache.put('c32', projection().mentionCandidates);
  assert.equal(cache.get('c1'), null); assert.ok(cache.get('c0')); assert.ok(cache.get('c32'));
  clock += 30000; assert.equal(cache.get('c32'), null);
  cache.put('c0', projection().mentionCandidates);
  cache.put('c2', projection().mentionCandidates);
  const oldAccount = cache.capture('c0'); f.store.accountId = 'charlie';
  assert.equal(cache.get('c0'), null); assert.throws(oldAccount, { code: 'COLLAB_CONVERSATION_STALE' });
  f.store.accountId = 'alice'; assert.equal(cache.get('c2'), null, 'account replacement clears every entry'); cache.put('c0', projection().mentionCandidates);
  const oldEpoch = cache.capture('c0'); cache.clear();
  assert.equal(cache.get('c0'), null); assert.throws(oldEpoch, { code: 'COLLAB_CONVERSATION_STALE' });
});

test('malformed/oversized candidates never overwrite management projection; coded capacity failure survives IPC', async (t) => {
  const f = fixture(t); await f.call('get-conversation-details');
  const malformed = projection(); malformed.members[0].role = 'member'; malformed.mentionCandidates.items[0].accessToken = 'SECRET'; f.value = malformed;
  assert.equal((await f.call('get-conversation-details')).code, 'COLLAB_MENTION_CANDIDATES_INVALID');
  assert.equal(f.store.listConversationMembers({ conversationId: 'c' })[0].role, 'owner');
  assert.equal((await f.call('get-mention-candidates')).code, 'COLLAB_MENTION_CANDIDATES_INVALID', 'a failed fresh projection cannot leave older candidates reusable');
  f.client.getConversationProjection = async () => { throw Object.assign(new Error('capacity'), { code: 'COLLAB_MENTION_CANDIDATES_LIMIT' }); };
  assert.equal((await f.call('get-conversation-details')).code, 'COLLAB_MENTION_CANDIDATES_LIMIT');
});

test('cached candidate IPC whitelists output and fences service/account replacement', async () => {
  const handlers = new Map(), pending = Promise.withResolvers();
  let current = { ok: true, getMentionCandidates: async () => ({ ok: true, conversationId: 'c', mentionCandidates: projection().mentionCandidates, members: [{ email: 'SECRET' }], accessToken: 'SECRET', canManage: true }) };
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => current });
  const call = () => handlers.get('collaboration:get-mention-candidates')(null, { conversationId: 'c' });
  assert.deepEqual(await call(), { ok: true, conversationId: 'c', mentionCandidates: projection().mentionCandidates });
  current.getMentionCandidates = async () => pending.promise;
  const old = call(); current = { ok: true }; pending.resolve({ ok: true, conversationId: 'c', mentionCandidates: projection().mentionCandidates });
  assert.equal((await old).code, 'COLLAB_ACCOUNT_CHANGED');
  assert.match(fs.readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8'), /getMentionCandidates:.*collaboration:get-mention-candidates/);
});

for (const variant of ['undefined', 'null', 'empty-success', 'invalid-id', 'other-conversation', 'missing-candidates', 'undefined-candidates', 'missing-ok', 'numeric-ok', 'string-ok']) test(`candidate IPC rejects malformed success envelope: ${variant}`, async () => {
  const handlers = new Map();
  let value = { ok: true, conversationId: 'c', mentionCandidates: projection().mentionCandidates };
  if (variant === 'undefined') value = undefined;
  if (variant === 'null') value = null;
  if (variant === 'empty-success') value = { ok: true };
  if (variant === 'invalid-id') value.conversationId = 'bad id';
  if (variant === 'other-conversation') value.conversationId = 'other';
  if (variant === 'missing-candidates') delete value.mentionCandidates;
  if (variant === 'undefined-candidates') value.mentionCandidates = undefined;
  if (variant === 'missing-ok') delete value.ok;
  if (variant === 'numeric-ok') value.ok = 1;
  if (variant === 'string-ok') value.ok = 'true';
  const service = { ok: true, getMentionCandidates: async () => value };
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  assert.deepEqual(await handlers.get('collaboration:get-mention-candidates')(null, { conversationId: 'c' }),
    { ok: false, code: 'COLLAB_MENTION_CANDIDATES_INVALID', retryable: false });
});

test('candidate IPC preserves explicit unknown/complete and structured failures while stripping extra fields', async () => {
  const handlers = new Map(); let value;
  const service = { ok: true, getMentionCandidates: async () => value };
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  const call = () => handlers.get('collaboration:get-mention-candidates')(null, { conversationId: 'c' });
  for (const mentionCandidates of [{ status: 'unknown', items: [] }, projection().mentionCandidates]) {
    value = { ok: true, conversationId: 'c', mentionCandidates, token: 'SECRET', canManage: true };
    assert.deepEqual(await call(), { ok: true, conversationId: 'c', mentionCandidates });
  }
  value = { ok: false, code: 'COLLAB_ACCESS_REVOKED', retryable: true, token: 'SECRET' };
  assert.deepEqual(await call(), { ok: false, code: 'COLLAB_ACCESS_REVOKED', retryable: true });
});

for (const outcome of ['resolve', 'reject']) test(`a directory-only update fences late ${outcome} without a bootstrap`, async (t) => {
  const f = fixture(t); await f.call('get-conversation-details');
  const entered = Promise.withResolvers(), pending = Promise.withResolvers();
  f.client.getConversationProjection = async () => { entered.resolve(); return pending.promise; };
  const old = f.call('get-conversation-details'); await entered.promise;
  f.store.db.run("INSERT INTO directory_team_members(account_id,team_id,user_id,display_name,role) VALUES('alice','org','new-team-user','New', 'member')");
  if (outcome === 'resolve') pending.resolve(projection()); else pending.reject(Object.assign(new Error('old denial'), { code: 'COLLAB_CONVERSATION_UNAVAILABLE' }));
  assert.equal((await old).code, 'COLLAB_CONVERSATION_STALE');
  assert.ok(f.store.getConversation({ conversationId: 'c' }));
});
