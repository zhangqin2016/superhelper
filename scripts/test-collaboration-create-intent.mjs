import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createCollaborationService } = require('../src/main/collaboration/service');
const { createCollaborationIpc } = require('../src/main/ipc-collaboration');
const { commandFor } = require('../src/main/collaboration/message-outbox-transport');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-create-intent-'));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString() };
const open = () => new CollaborationStore({ dbPath: path.join(dir, 'cache.db'), accountId: 'alice', keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys.json'), safeStorage }) });
let store = open();
const makeService = (deviceId = 'device-a') => createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId, realtimeEnabled: false,
  transport: { async submit() { throw Object.assign(new Error('offline'), { code: 'COLLAB_RESPONSE_UNKNOWN' }); } } });
try {
  store.replaceProjectionFromBootstrap({ conversations: [{ id: 'c', kind: 'direct' }] });
  let service = makeService();
  const handlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, getService: () => service });
  const ipc = (name, payload) => handlers.get(`collaboration:${name}`)({}, payload);
  const intent = { conversationId: 'c', clientCommandId: 'send-1', bodyText: 'same body', replyToMessageId: 'reply-old', mentionUserIds: ['bob', 'amy'] };
  assert.equal((await ipc('save-draft', { conversationId: 'c', text: intent.bodyText, replyToMessageId: 'reply-new', mentionUserIds: ['bob'] })).ok, true, 'typed IPC admits explicit reply/mention draft intent');
  assert.equal((await ipc('send', intent)).state, 'confirming');
  assert.deepEqual(await ipc('get-draft', { conversationId: 'c' }), { ok: true, text: 'same body', replyToMessageId: 'reply-new', mentionUserIds: ['bob'] }, 'older send cannot clear newer metadata with the same body');
  assert.equal((await ipc('send', { ...intent, replyToMessageId: 'other' })).code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await ipc('send', { ...intent, mentionUserIds: ['amy', 'bob'] })).ok, true, 'mention order is canonical wire intent');
  for (const patch of [{ mentionUserIds: ['bob', 'bob'] }, { mentionUserIds: ['bad id'] }, { mentionUserIds: Array.from({ length: 1001 }, (_, i) => `u${i}`) }, { replyToMessageId: 'bad\n' }, { replyToMessageId: 'x'.repeat(201) }, { senderUserId: 'forged' }, { originDeviceId: 'forged' }, { createdAt: 1 }]) {
    assert.equal((await ipc('send', { ...intent, ...patch })).code, 'COLLABORATION_INVALID_INPUT');
  }
  assert.equal((await ipc('send', { ...intent, clientCommandId: 'oversized', bodyText: '界'.repeat(10923) })).code, 'COLLABORATION_INVALID_INPUT');
  assert.equal(store.getOutbox({ outboxId: 'oversized' }), null, '32 KiB UTF-8 limit is enforced before persistence');
  assert.equal((await ipc('save-draft', { conversationId: 'c', text: 'x'.repeat(65536) })).ok, true, 'legacy 64 KiB editing remains supported');
  assert.equal((await service.send({ ...intent, clientCommandId: 'direct-oversize', bodyText: '界'.repeat(10923) })).code, 'COLLABORATION_INVALID_INPUT');
  service.stop(); store = open(); service = makeService();
  const pending = store.getOutbox({ outboxId: 'send-1' });
  assert.equal(pending.replyToMessageId, 'reply-old'); assert.deepEqual(pending.mentionUserIds, ['amy', 'bob']);
  const encrypted = store.db.get('SELECT payload_envelope_json FROM outbox WHERE account_id = ? AND id = ?', 'alice', 'send-1').payload_envelope_json;
  assert.equal(encrypted.includes('reply-old'), false); assert.equal(encrypted.includes('same body'), false, 'outbox intent is encrypted rather than SQLite plaintext');
  assert.equal(pending.originDeviceId, 'device-a');
  assert.deepEqual(commandFor(pending, 'device-a'), { action: 'send', deviceId: 'device-a', conversationId: 'c', clientCommandId: 'send-1', bodyText: 'same body', replyToMessageId: 'reply-old', mentionUserIds: ['amy', 'bob'] });
  store.replaceProjectionFromBootstrap({ conversations: [{ id: 'c', kind: 'direct' }] });
  const rebuilt = store.getMessage({ conversationId: 'c', messageId: 'optimistic:send-1' });
  assert.equal(rebuilt.replyToMessageId, 'reply-old'); assert.deepEqual(rebuilt.mentionUserIds, ['amy', 'bob']);
  assert.equal(rebuilt.createdAt, null, 'optimistic creation time is not server edit-window authority');
  store.persistDraftAndOptimisticMessage({ conversationId: 'c', draftId: 'composer', draftText: '', messageId: 'attachment', clientCommandId: 'attachment-command', bodyText: 'same body', attachmentIds: ['obj'], attachmentPurpose: 'attachment' });
  assert.equal((await service.send({ conversationId: 'c', clientCommandId: 'attachment-command', bodyText: 'same body' })).code, 'IDEMPOTENCY_KEY_REUSED', 'plain text cannot reuse attachment identity');
  service.saveDraft({ conversationId: 'c', text: 'clear', replyToMessageId: 'reply-old', mentionUserIds: ['bob'] });
  await service.send({ conversationId: 'c', clientCommandId: 'clear-command', bodyText: 'clear', replyToMessageId: 'reply-old', mentionUserIds: ['bob'] });
  assert.deepEqual(await ipc('get-draft', { conversationId: 'c' }), { ok: true, text: '', replyToMessageId: null, mentionUserIds: [] }, 'matching complete intent clears as one unit');
  service.stop(); store = open(); service = makeService(null);
  assert.equal((await service.send({ conversationId: 'c', clientCommandId: 'no-device', bodyText: 'cannot admit' })).code, 'COLLAB_OUTBOX_DEVICE_REQUIRED');
  assert.equal(store.getOutbox({ outboxId: 'no-device' }), null);
  service.stop();
  store = open();
  store.db.run('UPDATE drafts SET content_envelope_json = ? WHERE account_id = ? AND conversation_id = ? AND id = ?',
    store._encrypt({ scopeId: 'personal', recordId: store._draftRecord('c', 'composer'), value: { text: 'legacy' } }), 'alice', 'c', 'composer');
  const legacyDraft = store.getDraft({ conversationId: 'c', draftId: 'composer' });
  assert.equal(legacyDraft.replyToMessageId, null); assert.deepEqual(legacyDraft.mentionUserIds, [], 'legacy drafts expose explicit no-reply/no-mention defaults');
  console.log('collaboration complete create intent: ok');
} finally { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
