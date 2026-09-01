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
const { createCollaborationIpc, rendererView } = require('../src/main/ipc-collaboration');
const { applyAuthorizedConversation } = require('../src/main/collaboration/conversation-hydration');
const { removeConversationRows } = require('../src/main/collaboration/access-revocation');
const { hydratePendingConversation } = require('../src/main/collaboration/history-hydration');
const quote = { status: 'available', messageId: 'source', revision: 1, senderUserId: 'bob', createSeq: 1, kind: 'text', bodyText: 'quoted private text', truncated: false };
const row = { id: 'reply', conversationId: 'c', createSeq: 2, bodyText: 'answer', revision: 1, replyToMessageId: 'source', replySnapshot: quote };
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-service-'));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const store = new CollaborationStore({ accountId: 'alice', dbPath: path.join(dir, 'cache'), keyring });
  store.replaceProjectionFromBootstrap({ conversations: [{ id: 'c', kind: 'direct' }], members: [{ conversationId: 'c', userId: 'alice', status: 'active', joinedSeq: 0 }] });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: 'device', realtimeEnabled: false, ...options });
  const handlers = new Map(); let current = service;
  createCollaborationIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getService: () => current });
  const invoke = (name, payload) => handlers.get(`collaboration:${name}`)(null, payload);
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, service, invoke, switchService: (value) => { current = value; } };
}
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
const projection = (joinedSeq) => ({ conversation: { id: 'c', kind: 'direct', scopeType: 'personal', title: 'c', projectionSeq: 5, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 },
  members: [{ conversationId: 'c', userId: 'alice', status: 'active', role: 'member', joinedSeq }], profiles: [] });

test('real IPC open/readMessages exposes only validated quote and offline service reads cached quote', async (t) => {
  const f = fixture(t); f.store.hydrateAuthorizedHistory({ conversationId: 'c', messages: [row] });
  assert.deepEqual((await f.service.readMessages({ conversationId: 'c', messageIds: ['reply'] })).messages[0].replySnapshot, quote);
  assert.deepEqual((await f.invoke('open', { conversationId: 'c' })).messages[0].replySnapshot, quote);
  assert.deepEqual((await f.invoke('read-messages', { conversationId: 'c', messageIds: ['reply'] })).messages[0].replySnapshot, quote);
  assert.throws(() => rendererView('open', { messages: [{ ...row, replySnapshot: { status: 'revoked', bodyText: 'leak', credentials: 'secret', path: '/private' } }] }), { code: 'COLLAB_HISTORY_INVALID' });
});

test('IPC refuses reserved quote input across all message/draft commands', async (t) => {
  const f = fixture(t);
  for (const [command, payload] of [
    ['send', { conversationId: 'c', clientCommandId: 'cmd', bodyText: 'answer' }],
    ['save-draft', { conversationId: 'c', text: 'draft' }],
    ['edit', { conversationId: 'c', messageId: 'reply', clientCommandId: 'cmd', expectedRevision: 1, bodyText: 'edit' }],
    ['revoke', { conversationId: 'c', messageId: 'reply', clientCommandId: 'cmd', expectedRevision: 1 }],
  ]) for (const field of ['replySnapshot', 'replySnapshotCiphertext', 'replySnapshotKeyVersion']) {
    assert.equal((await f.invoke(command, { ...payload, [field]: quote })).code, 'COLLABORATION_INVALID_INPUT');
  }
  assert.deepEqual(f.store.listOutbox(), []);
});

for (const boundary of ['bootstrap', 'membership', 'remove-regrant']) test(`late authorized history cannot cross ${boundary}`, async (t) => {
  const pending = deferred(), started = deferred();
  const f = fixture(t, { client: { listMessageHistory: () => { started.resolve(); return pending.promise; } } });
  const opening = f.service.open({ conversationId: 'c' }); await started.promise;
  if (boundary === 'bootstrap') f.store.replaceProjectionFromBootstrap({ conversations: [{ id: 'c', kind: 'direct' }] });
  if (boundary === 'membership') applyAuthorizedConversation(f.store, 'c', projection(4));
  if (boundary === 'remove-regrant') {
    f.store.db.transaction(() => removeConversationRows(f.store, 'c', 'personal'))();
    applyAuthorizedConversation(f.store, 'c', projection(4));
  }
  pending.resolve({ messages: [row] });
  await assert.rejects(opening, { code: 'COLLAB_HISTORY_STALE' });
  assert.equal(f.store.getMessage({ conversationId: 'c', messageId: 'reply' }), null);
});

test('late target unavailable cannot delete/mask a regranted epoch', async (t) => {
  const f = fixture(t), pending = deferred(), started = deferred();
  f.store.db.run('INSERT INTO history_hydration_targets VALUES (?, ?, ?, ?)', 'alice', 'c', 'source', 1);
  const hydration = hydratePendingConversation({ store: f.store, deviceId: 'd', conversationId: 'c', assertActive: () => {}, client: {
    listMessageHistory: () => { started.resolve(); return pending.promise; },
  } });
  await started.promise;
  applyAuthorizedConversation(f.store, 'c', projection(4));
  f.store.hydrateAuthorizedHistory({ conversationId: 'c', messages: [row] });
  pending.resolve({ messages: [], unavailableMessageIds: ['source'] });
  await assert.rejects(hydration, { code: 'COLLAB_HISTORY_STALE' });
  assert.deepEqual(f.store.getMessage({ conversationId: 'c', messageId: 'reply' }).replySnapshot, quote);
});

test('bootstrap retains known revoke; new membership clears epoch-specific masks and quotes', (t) => {
  const f = fixture(t);
  f.service.syncEngine.applyPage({ fromCursor: 0, toCursor: 1, events: [{ id: 'e1', cursor: 1, seq: 3, type: 'message.revoked', conversationId: 'c', payload: { messageId: 'source', revision: 2 } }] });
  f.store.replaceProjectionFromBootstrap({ watermark: 1, conversations: [{ id: 'c', kind: 'direct' }], members: [{ conversationId: 'c', userId: 'alice', status: 'active', joinedSeq: 0 }], history: [row] });
  assert.deepEqual(f.store.getMessage({ conversationId: 'c', messageId: 'reply' }).replySnapshot, { status: 'revoked' });
  applyAuthorizedConversation(f.store, 'c', projection(4));
  assert.equal(f.store.getMessage({ conversationId: 'c', messageId: 'reply' }), null);
  assert.equal(f.store.db.get('SELECT COUNT(*) AS n FROM reply_source_masks').n, 0);
  f.store.hydrateAuthorizedHistory({ conversationId: 'c', messages: [row] });
  assert.deepEqual(f.store.getMessage({ conversationId: 'c', messageId: 'reply' }).replySnapshot, quote);
});

test('late service/account replacement never exposes a completed quote response', async (t) => {
  const pending = deferred(), started = deferred();
  const f = fixture(t, { client: { listMessageHistory: () => { started.resolve(); return pending.promise; } } });
  const opening = f.invoke('open', { conversationId: 'c' }); await started.promise;
  f.switchService({ ok: true }); f.service.stop(); pending.resolve({ messages: [row] });
  const result = await opening;
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(quote.bodyText), false);
});

test('friend accepted recreation gets a fresh history fence without changing ordinary same-epoch updates', async (t) => {
  const pending = deferred(), started = deferred();
  const f = fixture(t, { client: { listMessageHistory: () => { started.resolve(); return pending.promise; } } });
  const accepted = (cursor) => ({ cursor, id: `friend-${cursor}`, type: 'friend.accepted', conversationId: 'direct', actorUserId: 'bob', payload: {
    participantUserIds: ['alice', 'bob'], status: 'active', directConversation: { id: 'direct', scopeType: 'personal', kind: 'direct', participantUserIds: ['alice', 'bob'] },
  } });
  const apply = (cursor) => f.service.syncEngine.applyPage({ fromCursor: cursor - 1, toCursor: cursor, events: [accepted(cursor)] });
  apply(1);
  const opening = f.service.open({ conversationId: 'direct' }); await started.promise;
  f.store.db.transaction(() => removeConversationRows(f.store, 'direct', 'personal'))(); apply(2);
  pending.resolve({ messages: [{ ...row, conversationId: 'direct' }] });
  await assert.rejects(opening, { code: 'COLLAB_HISTORY_STALE' });
  assert.equal(f.store.countMessages({ conversationId: 'direct' }), 0);
  const generation = f.store.db.get("SELECT history_generation FROM conversations WHERE id = 'direct'").history_generation;
  apply(3);
  assert.equal(f.store.db.get("SELECT history_generation FROM conversations WHERE id = 'direct'").history_generation, generation);
});

for (const historyPath of ['page', 'target']) for (const code of ['COLLAB_MEMBERSHIP_INACTIVE', 'ECONNRESET']) {
  test(`late rejected ${historyPath} HTTP (${code}) cannot clean up a replacement bootstrap epoch`, async (t) => {
    const pending = deferred(), started = deferred(); let acknowledgements = 0;
    const snapshot = (watermark) => ({ watermark, conversations: [projection(0).conversation], members: projection(0).members });
    const f = fixture(t, { client: {
      bootstrap: async () => snapshot(1),
      listMessageHistory: (input) => {
        if (historyPath === 'target') assert.deepEqual(input.messageIds, ['source']);
        else assert.equal(input.messageIds, undefined);
        started.resolve(); return pending.promise;
      },
      acknowledgeCursor: async () => { acknowledgements++; },
    } });
    f.store.hydrateAuthorizedHistory({ conversationId: 'c', messages: [row] });
    if (historyPath === 'target') f.store.db.run("INSERT INTO history_hydration_targets VALUES ('alice', 'c', 'source', 1)");
    const operation = historyPath === 'page' ? f.service.open({ conversationId: 'c' }) : f.service.bootstrap();
    const rejected = assert.rejects(operation, { code: 'COLLAB_HISTORY_STALE' });
    await started.promise;
    f.store.replaceProjectionFromBootstrap({ ...snapshot(5), history: [
      { ...row, bodyText: 'new epoch answer', replySnapshot: { ...quote, bodyText: 'new epoch quote' } },
      { ...row, id: 'new-mask', createSeq: 3, replyToMessageId: 'unavailable-source', replySnapshot: { status: 'unavailable' } },
    ] });
    f.store.db.run("INSERT OR REPLACE INTO history_hydration_targets VALUES ('alice', 'c', 'source', 4)");
    const state = () => Object.fromEntries(['conversations', 'conversation_members', 'messages', 'reply_source_masks', 'revoked_conversations',
      'revoked_scopes', 'history_hydration', 'history_hydration_targets', 'sync_state'].map((table) => [table, f.store.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]));
    const before = state();
    pending.reject(Object.assign(new Error('old request failed'), { code }));
    await rejected;
    assert.deepEqual(state(), before, 'neither stale denial cleanup nor offline fallback may mutate the new authorization epoch');
    assert.equal(f.store.getMessage({ conversationId: 'c', messageId: 'reply' }).replySnapshot.bodyText, 'new epoch quote');
    assert.deepEqual(f.store.getSyncState(), { cursor: 5, watermark: 5 });
    assert.equal(acknowledgements, 0);
  });
}
