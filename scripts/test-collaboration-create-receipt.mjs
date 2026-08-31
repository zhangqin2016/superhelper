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
const wire = value => JSON.parse(JSON.stringify(value));
const good = { ok: true, state: 'completed', committed: true, commandType: 'message.create', conversationId: 'c',
  messageId: 'server-message', eventId: 'event', eventSequence: 9, sequence: 9, revision: 1 };
const unknown = { ok: true, state: 'unknown', committed: false, deliveryUnknown: true };
const malformedUnknowns = Object.entries({ pending: ['true', 1, null], ok: [undefined, null, 'true', 1],
  committed: [undefined, null, 'false', 0], deliveryUnknown: [undefined, null, 'true', 1],
  eventId: ['', 0], messageId: ['', false], sequence: [0, '9'], eventSequence: [0, '9'],
  commandType: ['', 'message.create'], conversationId: ['', 'c'], revision: [0, '1'], revoked: [false, 'false'] })
  .flatMap(([key, values]) => values.map(value => [`unknown ${key}=${JSON.stringify(value)}`, { ...unknown, [key]: value }]));
const validUnknowns = [unknown, { ...unknown, pending: false }, { ...unknown, pending: false,
  eventId: null, messageId: null, sequence: null, eventSequence: null, commandType: null, conversationId: null, revision: null, revoked: null }];
const invalids = [
  ...malformedUnknowns,
  ['current revoked projection', { ...good, revision: 3, revoked: true }],
  ...['ok', 'state', 'committed', 'commandType', 'conversationId', 'messageId', 'eventId', 'eventSequence', 'sequence', 'revision']
    .map(key => [`omitted ${key}`, { ...good, [key]: undefined }]),
  ...Object.entries({ ok: [false, 'true'], state: ['unknown', 'running'], committed: [false, 'true'],
    commandType: ['message.edit', null], conversationId: ['wrong', null],
    messageId: ['', 'bad id', 'bad\nid', 'x'.repeat(201), null, 3], eventId: ['', 'bad\u0085id', 'x'.repeat(201), null, 3],
    eventSequence: ['9', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, 8], sequence: ['9', 0, -1, 1.5, null, 8],
    revision: ['1', null, 0, 2, 3], revoked: [true, null, 'false', 0], pending: [true, 'true', 1, null], deliveryUnknown: [true, 'true', 1, null] })
    .flatMap(([key, values]) => values.map(value => [`invalid ${key}=${JSON.stringify(value)}`, { ...good, [key]: value }])),
  ['empty response', {}], ['null response', null],
  ...[{ ...unknown, eventId: 'event' }, { ...unknown, sequence: 9 }, { ...unknown, revision: 1 },
    { ...unknown, pending: true }, { ...unknown, committed: true }, { ...unknown, deliveryUnknown: undefined },
    { ...unknown, ok: false }].map(value => ['contradictory unknown', value]),
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-create-receipt-'));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString() };
const options = { dbPath: path.join(dir, 'cache.db'), accountId: 'alice', keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys.json'), safeStorage }) };
let store = new CollaborationStore(options);
let cases = 0;
try {
  for (const [i, [label, fixture]] of invalids.entries()) {
    const cid = `c${i}`, command = `command-${i}`, tail = `tail-${i}`;
    const response = wire(fixture?.conversationId === 'c' ? { ...fixture, conversationId: cid } : fixture);
    const sends = [], lookups = [], timers = [];
    const client = createCollaborationClient({ accountManager: { async accessTokenForService() { return { ok: true, accessToken: 'fixture' }; } }, signDeviceRequest: async () => ({}),
      async request(request) {
        if (request.body.action === 'send') { sends.push(wire(request.body)); return { ok: true, status: 200, json: {} }; }
        lookups.push(wire(request.body)); return { ok: true, status: 200, json: response };
      } });
    const transport = createCollaborationOutboxTransport({ client, deviceId: 'device-a' });
    const makeOutbox = () => createCollaborationOutbox({ store, deviceId: 'device-a', transport, setTimeoutFn(fn) { timers.push(fn); return fn; }, clearTimeoutFn() {} });
    store.persistDraftAndOptimisticMessage({ conversationId: cid, draftId: 'composer', messageId: `optimistic:${command}`, clientCommandId: command,
      bodyText: 'exact intent', replyToMessageId: 'reply', mentionUserIds: ['bob'], originDeviceId: 'device-a' });
    let outbox = makeOutbox();
    await outbox.submit(command);
    store.persistDraftAndOptimisticMessage({ conversationId: cid, draftId: 'composer', messageId: tail, clientCommandId: tail, bodyText: 'later', originDeviceId: 'device-a' });
    await outbox.reconcilePending();
    assert.equal(store.getOutbox({ outboxId: command }).deliveryConfirmed, false, `${label}: malformed receipt is never commit proof`);
    await timers.shift()();
    assert.equal(sends.length, 1, `${label}: malformed receipt never authorizes replay`);
    assert.equal(store.findOutboxPredecessor({ outboxId: tail }), command, `${label}: same-conversation barrier survives`);
    const cancelled = await outbox.cancel(command);
    assert.equal(cancelled.state, 'delivery_unknown', `${label}: cancellation cannot dismiss uncertainty`);
    assert.notEqual(cancelled.canRevoke, true);
    store.setOutboxState({ outboxId: command, expectedStates: ['delivery_unknown'], state: 'cancellation_requested' });
    outbox.stop(); store.close(); store = new CollaborationStore(options);
    outbox = makeOutbox(); await outbox.reconcilePending();
    const retained = store.getOutbox({ outboxId: command });
    assert.equal(retained.state, 'cancellation_requested', `${label}: restart preserves unresolved cancellation`);
    assert.equal(retained.deliveryConfirmed, false);
    assert.equal(retained.clientCommandId, command); assert.equal(retained.originDeviceId, 'device-a');
    assert.equal(store.findOutboxPredecessor({ outboxId: tail }), command);
    await outbox.submit(tail); assert.equal(sends.length, 1);
    const ownLookups = lookups.filter(request => request.expectedConversationId === cid);
    assert.ok(ownLookups.length >= 3);
    assert.ok(ownLookups.every(request => request.clientCommandId === command && request.deviceId === 'device-a'));
    outbox.stop(); cases++;
  }
  // Positive controls go through the same real SQLite/client/transport boundary.
  for (const [i, receipt] of [good, { ...good, revoked: false }, ...validUnknowns].entries()) {
    const cid = `positive-${i}`, command = `positive-command-${i}`, calls = [], timers = [];
    let replay = false;
    const client = createCollaborationClient({ accountManager: { async accessTokenForService() { return { ok: true, accessToken: 'fixture' }; } }, signDeviceRequest: async () => ({}),
      async request(request) {
        if (request.body.action !== 'send') return { ok: true, status: 200, json: wire(receipt.state === 'unknown' ? receipt : { ...receipt, conversationId: cid }) };
        calls.push(wire(request.body));
        return { ok: true, status: 200, json: replay ? { ok: true, result: { eventId: 'event', message: { id: 'server-message', conversationId: cid, seq: 9, revision: 1, revoked: false } } } : {} };
      } });
    const transport = createCollaborationOutboxTransport({ client, deviceId: 'device-a' });
    const makeOutbox = deviceId => createCollaborationOutbox({ store, deviceId, transport, setTimeoutFn(fn) { timers.push(fn); return fn; }, clearTimeoutFn() {} });
    store.persistDraftAndOptimisticMessage({ conversationId: cid, draftId: 'composer', messageId: `optimistic:${command}`, clientCommandId: command,
      bodyText: 'original', replyToMessageId: 'reply', mentionUserIds: ['bob'], originDeviceId: 'device-a' });
    let outbox = makeOutbox('device-a'); await outbox.submit(command); outbox.stop();
    store.close(); store = new CollaborationStore(options);
    outbox = makeOutbox('device-b'); await outbox.reconcilePending(); assert.equal(calls.length, 1); outbox.stop();
    timers.length = 0; replay = true; outbox = makeOutbox('device-a'); await outbox.reconcilePending();
    if (receipt.state === 'unknown') { await timers.shift()(); assert.deepEqual(calls[1], calls[0], 'explicit unknown alone permits original UUID/device/intent replay'); }
    else { assert.equal(store.getOutbox({ outboxId: command }).state, 'persisted'); assert.equal(calls.length, 1); }
    assert.equal(store.getOutbox({ outboxId: command }).deliveryConfirmed, true);
    outbox.stop(); cases++;
  }
  // The production unknown-proof boundary is shared by creates and mutations;
  // completed edit/revoke evidence keeps its existing typed settlement contract.
  for (const commandType of ['message.create', 'message.edit', 'message.revoke']) {
    for (const [label, receipt] of malformedUnknowns) {
      const transport = createCollaborationOutboxTransport({ deviceId: 'device-a', client: {
        async submitMessage() {}, async lookupCommandReceipt() { return wire(receipt); },
      } });
      await assert.rejects(() => transport.lookupReceipt({ clientCommandId: 'original', commandType, conversationId: 'c' }),
        error => error.code === 'COLLAB_RESPONSE_UNKNOWN', `${commandType}: ${label} is not replay proof`);
      cases++;
    }
    for (const receipt of validUnknowns) {
      const transport = createCollaborationOutboxTransport({ deviceId: 'device-a', client: {
        async submitMessage() {}, async lookupCommandReceipt() { return wire(receipt); },
      } });
      assert.deepEqual(await transport.lookupReceipt({ clientCommandId: 'original', commandType, conversationId: 'c' }), receipt);
      cases++;
    }
  }
  console.log(`collaboration production create receipt: ${cases} cases ok`);
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
