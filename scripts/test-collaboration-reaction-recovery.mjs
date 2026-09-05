import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { commandReceiptView } from '../server/src/services/collaboration/receipt-view.js';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createReactionCommand } = require('../src/main/collaboration/reaction-command');
const { reactionsForMessages } = require('../src/main/collaboration/message-reactions');
const { createCollaborationOutbox } = require('../src/main/collaboration/outbox');
const { createCollaborationOutboxTransport } = require('../src/main/collaboration/message-outbox-transport');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaction-recovery-'));
const openStore = () => new CollaborationStore({ dbPath: path.join(dir, 'db'), accountId: 'alice', keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => v.toString() } }) });
let store = openStore();
const intent = { commandType: 'message.reaction', conversationId: 'c', messageId: 'm', emoji: '👍', active: true, originDeviceId: 'device' };
let receipt, lost = false, rejected = false, submitted = 0;
const transport = createCollaborationOutboxTransport({ deviceId: 'device', client: {
  async submitMessage(command) { submitted++; if (rejected) throw Object.assign(new Error('denied'), { code: 'COLLAB_AUTHORIZATION_DENIED' }); if (lost) throw Object.assign(new Error('lost'), { code: 'COLLAB_RESPONSE_UNKNOWN' }); return { ok: true, result: { eventId: 'event', messageId: 'm', emoji: command.emoji, active: command.active } }; },
  async lookupCommandReceipt() { return receipt; },
} });
const openOutbox = () => createCollaborationOutbox({ store, transport, deviceId: 'device', setTimeoutFn: () => 1, clearTimeoutFn() {} });
let outbox = openOutbox();
try {
  store.replaceProjectionFromBootstrap({ conversations: [{ id: 'c', kind: 'group', scopeType: 'personal', title: 'Test' }] });
  store.persistMessageMutation({ ...intent, clientCommandId: 'add' });
  assert.equal((await outbox.submit('add')).state, 'persisted', 'a successful reaction ACK completes without requiring a message revision');
  store.persistMessageMutation({ ...intent, clientCommandId: 'remove', active: false });
  assert.equal((await outbox.submit('remove')).state, 'persisted', 'toggle off uses the same strict confirmation path');
  assert.equal(store.db.all('SELECT * FROM history_hydration_targets').length, 0, 'reactions never create phantom revision targets');
  store.persistMessageMutation({ ...intent, clientCommandId: 'lost' });
  lost = true;
  await outbox.submit('lost');
  outbox.stop(); store.close();
  store = openStore(); outbox = openOutbox();
  const event = { id: 'event', type: 'message.reaction', client_command_id: 'lost', conversation_id: 'c', seq: 9, payload: { messageId: 'm', emoji: '👍', active: true } };
  const stored = { state: 'completed', result_event_id: 'event', response_payload: { eventId: 'event', messageId: 'm', emoji: '👍', active: true } };
  const evidence = commandReceiptView(stored, event, { commandType: 'message.reaction', clientCommandId: 'lost' });
  assert.equal(evidence.revision, undefined);
  for (const patch of [{ emoji: '🎉' }, { active: false }, { active: undefined }, { messageId: 'other' }]) {
    receipt = { ok: true, ...evidence, ...patch };
    await outbox.reconcilePending();
    assert.equal(store.getOutbox({ outboxId: 'lost' }).state, 'confirming', 'mismatched evidence cannot settle');
    assert.throws(() => store.settleOutboxFromSync({ clientCommandId: 'lost', ...receipt }), /receipt does not match/);
  }
  receipt = { ok: true, ...evidence };
  await outbox.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: 'lost' }).state, 'persisted', 'receipt recovers a lost ACK');
  assert.equal(submitted, 3, 'receipt recovery must not resend the reaction');
  for (const patch of [{ active: 'true' }, { emoji: '🎉' }, { messageId: 'other' }]) assert.throws(() => commandReceiptView({ ...stored, response_payload: { ...stored.response_payload, ...patch } }, event, { commandType: 'message.reaction', clientCommandId: 'lost' }), /inconsistent/);
  store.persistDraftAndOptimisticMessage({ conversationId: 'c', draftId: 'd', messageId: 'm', clientCommandId: 'create', bodyText: 'test', scopeId: 'personal' });
  store.settleOutboxFromSync({ clientCommandId: 'create', eventId: 'created', messageId: 'm', sequence: 1 });
  const react = createReactionCommand({ store, getOutbox: () => outbox, deviceId: 'device', isStopped: () => false });
  rejected = true; lost = false;
  await assert.rejects(react({ conversationId: 'c', messageId: 'm', clientCommandId: 'denied', emoji: '😂', active: true }), /denied/);
  assert.equal(reactionsForMessages(store, ['m']).m?.some(r => r.emoji === '😂') || false, false, 'definitive rejection rolls back optimism');
  assert.equal(store.getOutbox({ outboxId: 'denied' }).state, 'cancelled', 'definitively rejected reactions do not block later sends');
  rejected = false;
  assert.equal((await react({ conversationId: 'c', messageId: 'm', clientCommandId: 'after-denied', emoji: '👍', active: true })).state, 'persisted');
  console.log('collaboration reaction recovery: ok');
} finally { outbox.stop(); store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); }
