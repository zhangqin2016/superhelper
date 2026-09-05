import { CollaborationCommandError } from "./idempotency.js";

export function receiptEvidenceError() {
  return new CollaborationCommandError("COLLAB_RECEIPT_EVIDENCE_INVALID", "Stored receipt evidence is inconsistent.");
}
function objectPayload(value) {
  let parsed = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { throw receiptEvidenceError(); } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw receiptEvidenceError();
  return parsed;
}
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
function matchesWhenPresent(value, key, expected) {
  if (Object.hasOwn(value, key) && value[key] !== expected) throw receiptEvidenceError();
}

// This projection reads only the original receipt and its immutable linked
// event. The live message may already be edited/revoked and is not evidence
// of the original command result. Legacy creates did not store revision one.
export function commandReceiptView(receipt, event, { commandType, clientCommandId }) {
  const eventTypes = { "message.create": "message.created", "message.edit": "message.edited", "message.revoke": "message.revoked", "message.reaction": "message.reaction" };
  const sequence = Number(event?.seq);
  if (receipt?.state !== "completed" || !identifier(event?.id) || event.id !== receipt.result_event_id
    || !identifier(event.conversation_id) || !eventTypes[commandType] || event.type !== eventTypes[commandType]
    || event.client_command_id !== clientCommandId || !Number.isSafeInteger(sequence) || sequence <= 0) throw receiptEvidenceError();
  const eventPayload = objectPayload(event.payload);
  const messageId = eventPayload.messageId ?? eventPayload.message_id;
  if (commandType === "message.reaction") {
    const { emoji, active } = eventPayload;
    if (!identifier(messageId) || typeof emoji !== "string" || !emoji || emoji.length > 32 || [...emoji].length > 8 || /\s/u.test(emoji) || typeof active !== "boolean") throw receiptEvidenceError();
    const payload = objectPayload(receipt.response_payload);
    const envelopes = [eventPayload, payload];
    if (Object.hasOwn(payload, "result")) envelopes.push(objectPayload(payload.result));
    for (const envelope of envelopes) {
      for (const [key, expected] of Object.entries({ eventId: event.id, messageId, message_id: messageId,
        conversationId: event.conversation_id, emoji, active })) matchesWhenPresent(envelope, key, expected);
    }
    return { state: "completed", committed: true, commandType, conversationId: event.conversation_id,
      eventId: event.id, messageId, emoji, active, eventSequence: sequence, sequence };
  }
  const create = commandType === "message.create", revoked = commandType === "message.revoke";
  const revision = create ? 1 : eventPayload.revision;
  if (!identifier(messageId) || !Number.isSafeInteger(revision) || revision <= 0) throw receiptEvidenceError();
  const payload = objectPayload(receipt.response_payload);
  const envelopes = [eventPayload, payload];
  if (Object.hasOwn(payload, "result")) envelopes.push(objectPayload(payload.result));
  for (const envelope of envelopes) {
    for (const [key, expected] of Object.entries({ eventId: event.id, messageId, message_id: messageId,
      conversationId: event.conversation_id, eventSequence: sequence, sequence, revision, revoked })) matchesWhenPresent(envelope, key, expected);
    if (create) matchesWhenPresent(envelope, "seq", sequence);
    if (Object.hasOwn(envelope, "message")) {
      const message = objectPayload(envelope.message);
      for (const [key, expected] of Object.entries({ id: messageId, conversationId: event.conversation_id, revision, revoked })) matchesWhenPresent(message, key, expected);
      // Mutation response.message.seq historically held the creation sequence.
      // Its receipt sequence is always the separately verified mutation event.
      if (create) matchesWhenPresent(message, "seq", sequence);
    }
  }
  return { state: "completed", committed: true, commandType, conversationId: event.conversation_id,
    eventId: event.id, messageId, revision, ...(revoked ? { revoked: true } : {}), eventSequence: sequence, sequence };
}
