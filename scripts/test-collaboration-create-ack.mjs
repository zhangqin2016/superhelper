import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createCollaborationClient } = require('../src/main/collaboration/client');
const { createCollaborationOutboxTransport } = require('../src/main/collaboration/message-outbox-transport');
const { createCollaborationOutbox } = require('../src/main/collaboration/outbox');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-create-ack-'));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString() };
const options = { dbPath: path.join(dir, 'cache.db'), accountId: 'alice', keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys.json'), safeStorage }) };
let store = new CollaborationStore(options);
try {
  const good = { ok: true, result: { eventId: 'event', message: { id: 'server-message', conversationId: 'c', seq: 3, revision: 1, revoked: false } } };
  const invalids = [null, {}, { ok: true }, { ...good, result: { ...good.result, message: { ...good.result.message, conversationId: 'wrong' } } },
    ...['3', 0, null].map(seq => ({ ...good, result: { ...good.result, message: { ...good.result.message, seq } } })),
    { ...good, result: { ...good.result, eventId: 'bad\nid' } },
    ...[undefined, null, '1', 0, 2, 3].map(revision => ({ ...good, result: { ...good.result, message: { ...good.result.message, revision } } })),
    ...[undefined, null, 'false', 0, true].map(revoked => ({ ...good, result: { ...good.result, message: { ...good.result.message, revoked } } })),
    { ...good, result: { eventId: 'revoke-event', message: { id: 'old-message', conversationId: 'c', seq: 9, revision: 3, revoked: true } } }];
  for (const [i, fixtureResponse] of invalids.entries()) {
    const cid = `c${i}`, command = `cmd${i}`;
    // All field-malformation cases except the explicit wrong-conversation
    // case must match this command, so conversation rejection cannot mask a
    // missing revision/revocation check.
    const response = JSON.parse(JSON.stringify(fixtureResponse?.result?.message?.conversationId === 'c'
      ? { ...fixtureResponse, result: { ...fixtureResponse.result, message: { ...fixtureResponse.result.message, conversationId: cid } } } : fixtureResponse));
    store.db.run('INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES(?,?,?,?,?)', 'alice', cid, 'personal', 'direct', 1);
    store.persistDraftAndOptimisticMessage({ conversationId: cid, draftId: 'composer', messageId: `optimistic:${command}`, clientCommandId: command, bodyText: 'exact', replyToMessageId: 'reply', mentionUserIds: ['bob'], originDeviceId: 'device-a' });
    const calls = [];
    let replay = false;
    const client = createCollaborationClient({ accountManager: { async accessTokenForService() { return { ok: true, accessToken: 'fixture' }; } }, signDeviceRequest: async () => ({}),
      async request(request) { calls.push(request.body); return { ok: true, status: 200, json: replay ? { ...good, result: { ...good.result, message: { ...good.result.message, conversationId: cid } } } : response }; } });
    const transport = createCollaborationOutboxTransport({ client, deviceId: 'device-a' });
    await assert.rejects(transport.submit(store.getOutbox({ outboxId: command })), error => error.code === 'COLLAB_RESPONSE_UNKNOWN',
      `malformed creation ACK case ${i} must remain an ambiguous response at the production boundary`);
    calls.length = 0;
    let outbox = createCollaborationOutbox({ store, deviceId: 'device-a', transport, setTimeoutFn() { return null; }, clearTimeoutFn() {} });
    await outbox.submit(command);
    assert.equal(store.getOutbox({ outboxId: command }).state, 'confirming');
    assert.equal(store.getOutbox({ outboxId: command }).deliveryConfirmed, false, `malformed production HTTP 200 case ${i} cannot release the lane barrier`);
    store.persistDraftAndOptimisticMessage({ conversationId: cid, draftId: 'composer', messageId: `tail${i}`, clientCommandId: `tail${i}`, bodyText: 'later', originDeviceId: 'device-a' });
    assert.equal(store.findOutboxPredecessor({ outboxId: `tail${i}` }), command);
    outbox.stop(); store.close(); store = new CollaborationStore(options);
    replay = true;
    transport.lookupReceipt = async () => ({ state: 'unknown', committed: false, deliveryUnknown: true });
    const timers = [];
    outbox = createCollaborationOutbox({ store, deviceId: 'device-a', transport, setTimeoutFn(fn) { timers.push(fn); return fn; }, clearTimeoutFn() {} });
    await outbox.reconcilePending();
    await timers.shift()();
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0], 'recovery reuses complete original-device wire intent and UUID');
    assert.equal(store.getOutbox({ outboxId: command }).deliveryConfirmed, true);
    outbox.stop();
  }
  let foreignCalls = 0;
  const foreign = createCollaborationOutbox({ store, deviceId: 'device-b', transport: { async submit() { foreignCalls++; } } });
  assert.equal((await foreign.submit('tail0')).code, 'COLLAB_OUTBOX_DEVICE_CHANGED'); assert.equal(foreignCalls, 0); foreign.stop();
  console.log('collaboration production create ACK: ok');
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
