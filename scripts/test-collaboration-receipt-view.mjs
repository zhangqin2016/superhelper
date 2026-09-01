import assert from 'node:assert/strict';
import { commandReceiptView } from '../server/src/services/collaboration/receipt-view.js';

const input = { commandType: 'message.create', clientCommandId: 'send' };
const event = { id: 'event', type: 'message.created', client_command_id: 'send', conversation_id: 'c', seq: '9', payload: { messageId: 'message' } };
const payload = { eventId: 'event', message: { id: 'message', seq: 9 } };
const receipt = { state: 'completed', result_event_id: 'event', response_payload: payload };
const good = { state: 'completed', committed: true, commandType: 'message.create', conversationId: 'c', eventId: 'event',
  messageId: 'message', revision: 1, eventSequence: 9, sequence: 9 };
assert.deepEqual(commandReceiptView(receipt, event, input), good, 'legacy creation evidence derives revision one without consulting the current message');
assert.deepEqual(commandReceiptView({ ...receipt, response_payload: JSON.stringify(payload) }, { ...event, payload: JSON.stringify(event.payload) }, input), good);
let cases = 2;
const rejects = (candidate, linkedEvent = event, request = input) => {
  assert.throws(() => commandReceiptView(candidate, linkedEvent, request), error => error.code === 'COLLAB_RECEIPT_EVIDENCE_INVALID'); cases++;
};
for (const changes of [{ id: 'other' }, { type: 'message.edited' }, { client_command_id: 'other' }, { seq: null }, { seq: 0 }, { seq: '9x' },
  { payload: {} }, { payload: { messageId: 'message', message_id: 'other' } }, { payload: { messageId: 'message', revision: 3 } },
  { payload: { messageId: 'message', revoked: true } }]) rejects(receipt, { ...event, ...changes });
rejects({ ...receipt, result_event_id: 'other' });
rejects({ ...receipt, state: 'running' });
for (const response_payload of [null, [], 'bad-json', { result: null }, { message: null }]) rejects({ ...receipt, response_payload });
for (const [key, values] of Object.entries({ eventId: ['other', null, 4], messageId: ['other', null], conversationId: ['other', null],
  sequence: [8, '9', null], eventSequence: [8, '9', null], revision: [2, '1', null], revoked: [true, 'false', null] })) {
  for (const value of values) for (const nesting of ['outer', 'result']) {
    const corrupt = { ...payload, [key]: value };
    rejects({ ...receipt, response_payload: nesting === 'outer' ? { ...corrupt, result: payload } : { ...payload, result: corrupt } });
  }
}
for (const [key, values] of Object.entries({ id: ['other', null], conversationId: ['other', null], seq: [8, '9', null], revision: [2, '1', null], revoked: [true, 'false', null] })) {
  for (const value of values) for (const nesting of ['outer', 'result']) {
    const corrupt = { ...payload, message: { ...payload.message, [key]: value } };
    rejects({ ...receipt, response_payload: nesting === 'outer' ? { ...corrupt, result: payload } : { ...payload, result: corrupt } });
  }
}
for (const [commandType, type, revision] of [['message.edit', 'message.edited', 2], ['message.revoke', 'message.revoked', 3]]) {
  const mutation = commandReceiptView({ ...receipt, response_payload: { eventId: 'event', result: { message: { id: 'message', conversationId: 'c', seq: 1, revision,
    ...(commandType === 'message.revoke' ? { revoked: true } : {}) } } } },
  { ...event, type, payload: { messageId: 'message', revision } }, { ...input, commandType });
  assert.equal(mutation.eventSequence, 9, 'mutation receipt order is not the stored creation sequence');
  assert.equal(mutation.revision, revision);
  if (commandType === 'message.revoke') assert.equal(mutation.revoked, true);
  cases++;
}
console.log(`collaboration immutable receipt view: ${cases} cases ok`);
