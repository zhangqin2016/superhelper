import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createCollaborationSyncEngine } = require('../src/main/collaboration/sync-engine');
const { hydratePendingConversation } = require('../src/main/collaboration/history-hydration');
const quote = { status: 'available', messageId: 'source', revision: 2, senderUserId: 'bob', createSeq: 1, kind: 'text', bodyText: 'private send-time quote 🔒', truncated: false };
const reply = (id = 'reply', createSeq = 2, snapshot = quote) => ({ id, conversationId: 'c', createSeq, revision: 1, bodyText: 'reply text', replyToMessageId: 'source', replySnapshot: snapshot });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-cache-'));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys.json'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } });
  let store;
  const reopen = () => store = new CollaborationStore({ dbPath: path.join(dir, 'cache.db'), accountId: 'alice', keyring });
  reopen();
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  store.replaceProjectionFromBootstrap({ conversations: [{ id: 'c', kind: 'direct' }] });
  return { get store() { return store; }, reopen, dir };
}
const get = (store, id = 'reply') => store.getMessage({ conversationId: 'c', messageId: id });
const hydrate = (store, messages) => store.hydrateAuthorizedHistory({ conversationId: 'c', messages });
const revoke = (store, cursor = 1, extra = []) => createCollaborationSyncEngine({ store }).applyPage({ fromCursor: cursor - 1, toCursor: cursor + extra.length,
  events: [{ id: `e${cursor}`, cursor, seq: 999, type: 'message.revoked', conversationId: 'c', payload: { messageId: 'source', revision: 3 } }, ...extra] });

test('authorized quote is encrypted, survives reopen, and never becomes outbox/draft intent', (t) => {
  const f = fixture(t);
  hydrate(f.store, [reply()]);
  assert.deepEqual(get(f.store).replySnapshot, quote);
  assert.deepEqual(f.store.listMessages({ conversationId: 'c' })[0].replySnapshot, quote);
  for (const table of f.store.db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    assert.ok(!JSON.stringify(f.store.db.all(`SELECT * FROM ${table.name}`)).includes(quote.bodyText), table.name);
  }
  f.store.close(); f.reopen();
  assert.deepEqual(get(f.store).replySnapshot, quote);
  hydrate(f.store, [{ id: 'source', createSeq: 1, revision: 3, bodyText: 'source edited later' }]);
  assert.deepEqual(get(f.store).replySnapshot, quote, 'current source must not rebuild send-time quote');
  f.store.persistDraftAndOptimisticMessage({ conversationId: 'c', draftId: 'composer', messageId: 'pending', clientCommandId: 'cmd', bodyText: 'new', replyToMessageId: 'source', replySnapshot: quote });
  assert.equal(f.store.getOutbox({ outboxId: 'cmd' }).replySnapshot, undefined);
  assert.equal(f.store.getDraft({ conversationId: 'c', draftId: 'composer' }).replySnapshot, undefined);
});

test('source revoke masks all old/future references without a source cache row or unbounded decryption', (t) => {
  const f = fixture(t);
  hydrate(f.store, Array.from({ length: 451 }, (_, i) => reply(`r${i}`, i + 2)));
  let decrypts = 0;
  const decrypt = f.store._decrypt.bind(f.store);
  f.store._decrypt = (...args) => { decrypts++; return decrypt(...args); };
  revoke(f.store);
  assert.equal(decrypts, 0, 'revocation writes metadata, not a scan of decrypted history');
  assert.deepEqual(get(f.store, 'r0').replySnapshot, { status: 'revoked' });
  assert.ok(f.store.listMessages({ conversationId: 'c' }).every((m) => m.replySnapshot.status === 'revoked'));
  hydrate(f.store, [reply('later', 999), reply('r0', 2)]);
  assert.deepEqual(get(f.store, 'later').replySnapshot, { status: 'revoked' });
  assert.deepEqual(get(f.store, 'r0').replySnapshot, { status: 'revoked' });
  f.store.close(); f.reopen();
  assert.deepEqual(get(f.store, 'r0').replySnapshot, { status: 'revoked' });
});

test('mask and cursor roll back together', (t) => {
  const f = fixture(t); hydrate(f.store, [reply()]);
  assert.throws(() => revoke(f.store, 1, [{ id: 'e2', cursor: 2, type: 'test.failure', payload: { failProjection: true } }]));
  assert.equal(f.store.getSyncState().cursor, 0);
  assert.deepEqual(get(f.store).replySnapshot, quote);
});

test('explicit target unavailable masks references, whereas failed network requests preserve quotes', async (t) => {
  const f = fixture(t); hydrate(f.store, [reply()]);
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [{ id: 'edit', cursor: 1, seq: 3, type: 'message.edited', conversationId: 'c', payload: { messageId: 'source', revision: 3 } }] });
  const run = (client) => hydratePendingConversation({ store: f.store, client, deviceId: 'd', conversationId: 'c', assertActive: () => {} });
  await assert.rejects(run({ listMessageHistory: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); } }));
  assert.deepEqual(get(f.store).replySnapshot, quote);
  await run({ listMessageHistory: async () => ({ messages: [], unavailableMessageIds: ['source'] }) });
  assert.deepEqual(get(f.store).replySnapshot, { status: 'unavailable' });
  hydrate(f.store, [reply()]);
  assert.deepEqual(get(f.store).replySnapshot, { status: 'unavailable' }, 'same-revision stale history cannot revive quote');
});

test('legacy missing quote is explicit and never inferred from a cached source', (t) => {
  const f = fixture(t);
  hydrate(f.store, [{ id: 'source', createSeq: 1, bodyText: 'current source' }, reply('legacy', 2, undefined)]);
  const legacy = reply('old', 3); delete legacy.replySnapshot; hydrate(f.store, [legacy]);
  assert.deepEqual(get(f.store, 'old').replySnapshot, { status: 'unavailable', reason: 'legacy' });
  assert.equal(get(f.store, 'source').replySnapshot, null);
});

for (const snapshot of [
  { ...quote, secret: 'credential' }, { ...quote, messageId: 'wrong' }, { ...quote, revision: '2' }, { ...quote, revision: 0 },
  { ...quote, createSeq: 0 }, { ...quote, bodyText: 'x'.repeat(513) }, { ...quote, bodyText: '🔒'.repeat(513) },
  { ...quote, truncated: 'yes' }, { ...quote, kind: 'unknown' }, { status: 'revoked', bodyText: 'secret' },
  { status: 'unavailable', path: '/tmp/secret' }, { status: 'unavailable', reason: 'guess' }, [], 'bad',
]) test(`invalid snapshot rolls back full page: ${JSON.stringify(snapshot).slice(0, 100)}`, (t) => {
  const f = fixture(t);
  assert.throws(() => hydrate(f.store, [reply('good', 2), reply('bad', 3, snapshot)]), { code: 'COLLAB_HISTORY_INVALID' });
  assert.equal(f.store.countMessages(), 0);
});

test('masked server quote cannot leak extra body and own revoke does not revoke the source', (t) => {
  const f = fixture(t);
  hydrate(f.store, [reply(), { ...reply('own-revoke', 3, { status: 'unavailable' }), revokedAt: '2026-08-31', revision: 2 }]);
  assert.deepEqual(get(f.store, 'own-revoke').replySnapshot, { status: 'unavailable' });
  assert.deepEqual(get(f.store).replySnapshot, quote);
  hydrate(f.store, [reply('server-mask', 4, { status: 'revoked' })]);
  assert.deepEqual(get(f.store).replySnapshot, { status: 'revoked' });
});

test('invisible/legacy source quotes are not promoted to revoked by later source events', (t) => {
  const f = fixture(t);
  hydrate(f.store, [reply('invisible', 2, { status: 'unavailable' }), reply('legacy', 3, { status: 'unavailable', reason: 'legacy' })]);
  revoke(f.store);
  assert.deepEqual(get(f.store, 'invisible').replySnapshot, { status: 'unavailable' });
  assert.deepEqual(get(f.store, 'legacy').replySnapshot, { status: 'unavailable', reason: 'legacy' });
  hydrate(f.store, [reply('invisible', 2)]);
  assert.deepEqual(get(f.store, 'invisible').replySnapshot, { status: 'unavailable' });
});

test('same-page removal followed by a source event cannot leave masks in a revoked conversation', (t) => {
  const f = fixture(t); hydrate(f.store, [reply()]);
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 2, events: [
    { id: 'removed', cursor: 1, type: 'member.removed', conversationId: 'c', payload: { userId: 'alice' } },
    { id: 'revoked', cursor: 2, type: 'message.revoked', conversationId: 'c', payload: { messageId: 'source', revision: 3 } },
  ] });
  assert.equal(get(f.store), null);
  assert.equal(f.store.db.get('SELECT COUNT(*) AS n FROM reply_source_masks').n, 0);
});

test('bootstrap discards masks for unknown conversations absent from the authorized snapshot', (t) => {
  const f = fixture(t);
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [
    { id: 'unknown-revoke', cursor: 1, type: 'message.revoked', conversationId: 'unknown', payload: { messageId: 'source', revision: 3 } },
  ] });
  assert.equal(f.store.db.get('SELECT COUNT(*) AS n FROM reply_source_masks').n, 1);
  f.store.replaceProjectionFromBootstrap({ watermark: 1, conversations: [{ id: 'c', kind: 'direct' }] });
  assert.equal(f.store.db.get('SELECT COUNT(*) AS n FROM reply_source_masks').n, 0);
});

test('populated v13 cache upgrades durably without rewriting encrypted data or rotating stable generations', (t) => {
  const { openDatabase } = require('../src/main/store/sqlite-db');
  const { COLLABORATION_MIGRATIONS } = require('../src/main/collaboration/schema');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-cache-v13-'));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys.json'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } });
  const dbPath = path.join(dir, 'cache.db');
  let db = openDatabase(dbPath), store;
  t.after(() => { store?.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.migrate(COLLABORATION_MIGRATIONS.slice(0, 13));
  assert.equal(db.pragma('user_version'), 13);
  assert.equal(db.all('PRAGMA table_info(conversations)').some((column) => column.name === 'history_generation'), false);
  for (const accountId of ['alice', 'bob']) db.run("INSERT INTO conversations VALUES (?, 'c', 'personal', 'direct', 'old title', 10)", accountId);
  const encrypt = (recordId, value) => JSON.stringify(keyring.encrypt({ accountId: 'alice', scopeId: 'personal', recordId, plaintext: JSON.stringify(value) }));
  const oldBody = 'existing encrypted v13 message';
  const messageEnvelope = encrypt('message:c:reply', { bodyText: oldBody, revision: 2, replyToMessageId: 'source', mentionUserIds: [] });
  const draftEnvelope = encrypt('draft:c:composer', { text: 'retained draft', replyToMessageId: 'source', mentionUserIds: [] });
  db.run(`INSERT INTO messages (account_id, conversation_id, id, scope_id, seq, state, body_envelope_json, created_at, updated_at)
    VALUES ('alice', 'c', 'reply', 'personal', 2, 'persisted', ?, 10, 11)`, messageEnvelope);
  db.run("INSERT INTO drafts VALUES ('alice', 'c', 'composer', 'personal', ?, 12)", draftEnvelope);
  db.run("INSERT INTO sync_state VALUES ('alice', 7, 7, 13)");
  db.close();

  const reopen = () => store = new CollaborationStore({ dbPath, accountId: 'alice', keyring });
  reopen(); db = store.db;
  assert.equal(db.pragma('user_version'), 14);
  assert.equal(get(store).bodyText, oldBody);
  assert.deepEqual(get(store).replySnapshot, { status: 'unavailable', reason: 'legacy' });
  assert.equal(store.getDraft({ conversationId: 'c', draftId: 'composer' }).text, 'retained draft');
  assert.equal(db.get("SELECT body_envelope_json FROM messages WHERE account_id='alice'").body_envelope_json, messageEnvelope);
  assert.equal(db.get("SELECT content_envelope_json FROM drafts WHERE account_id='alice'").content_envelope_json, draftEnvelope);
  assert.deepEqual(store.getSyncState(), { cursor: 7, watermark: 7 });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM reply_source_masks').n, 0);
  const generations = () => db.all('SELECT account_id, id, history_generation FROM conversations ORDER BY account_id, id');
  const backfilled = generations();
  assert.equal(backfilled.length, 2);
  for (const entry of backfilled) assert.match(entry.history_generation, /^[a-f0-9]{32}$/);
  assert.notEqual(backfilled[0].history_generation, backfilled[1].history_generation);
  db.run("INSERT INTO conversations (account_id,id,scope_id,kind,title,updated_at) VALUES ('alice','new','personal','direct','new title',14)");
  const inserted = db.get("SELECT history_generation FROM conversations WHERE account_id='alice' AND id='new'").history_generation;
  assert.match(inserted, /^[a-f0-9]{32}$/);
  assert.ok(backfilled.every((entry) => entry.history_generation !== inserted), 'the migrated INSERT trigger creates a fresh generation');
  db.run(`INSERT INTO conversations (account_id,id,scope_id,kind,title,updated_at) VALUES ('alice','new','personal','direct','updated title',15)
    ON CONFLICT(account_id,id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`);
  assert.equal(db.get("SELECT history_generation FROM conversations WHERE account_id='alice' AND id='new'").history_generation, inserted);
  const stable = generations();
  assert.equal(db.migrate(COLLABORATION_MIGRATIONS), 14);
  assert.deepEqual(generations(), stable, 'repeated migration is a no-op for existing authorizations');
  store.close(); reopen(); db = store.db;
  assert.deepEqual(generations(), stable, 'opening the persisted upgraded cache does not rotate generations');
  assert.equal(get(store).bodyText, oldBody);
  assert.equal(db.get("SELECT body_envelope_json FROM messages WHERE account_id='alice'").body_envelope_json, messageEnvelope);
  assert.equal(db.get("SELECT content_envelope_json FROM drafts WHERE account_id='alice'").content_envelope_json, draftEnvelope);
});
