"use strict";

const access = require("./access-revocation");

const CREATE = "message.create";
const MUTATIONS = new Set(["message.edit", "message.revoke"]);
const id = (value, label) => {
  const text = String(value || "").trim();
  if (!text || text.length > 512) throw new Error(`collaboration mutation: ${label} is required`);
  return text;
};
const positive = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`collaboration mutation: ${label} is invalid`);
  return value;
};
function requiredOriginDevice(value) {
  try { return id(value, "origin device id"); } catch {
    const error = new Error("Collaboration mutations require their original device identity");
    error.code = "COLLAB_OUTBOX_DEVICE_REQUIRED";
    throw error;
  }
}

function normalizeOutboxIntent(value = {}) {
  const commandType = value.commandType == null ? CREATE : String(value.commandType);
  if (commandType === CREATE) return { ...value, commandType };
  if (!MUTATIONS.has(commandType)) {
    const error = new Error("Unsupported collaboration outbox command");
    error.code = "COLLAB_OUTBOX_COMMAND_UNSUPPORTED";
    throw error;
  }
  const result = {
    commandType,
    messageId: id(value.messageId, "message id"),
    clientCommandId: id(value.clientCommandId, "client command id"),
    expectedRevision: positive(value.expectedRevision, "expected revision"),
  };
  if (commandType === "message.edit") result.bodyText = String(value.bodyText ?? "");
  result.originDeviceId = requiredOriginDevice(value.originDeviceId);
  return result;
}

function persistMessageMutation(store, input = {}) {
  const conversationId = id(input.conversationId, "conversation id");
  const intent = normalizeOutboxIntent(input);
  if (!MUTATIONS.has(intent.commandType)) throw new Error("collaboration mutation: command type is required");
  const conversation = store.getConversation({ conversationId });
  if (!conversation) throw new Error("collaboration mutation: conversation not found");
  if (access.isConversationRevoked(store, conversationId)) throw new Error("collaboration conversation revoked");
  const now = store.now();
  const write = store.db.transaction(() => {
    store.db.run(
      `INSERT INTO outbox (account_id,id,conversation_id,client_command_id,scope_id,state,payload_envelope_json,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      store.accountId, intent.clientCommandId, conversationId, intent.clientCommandId, conversation.scopeId,
      store._encrypt({ scopeId: conversation.scopeId, recordId: store._outboxRecord(intent.clientCommandId), value: intent }), now, now,
    );
    return { outboxId: intent.clientCommandId };
  });
  return write();
}

function isCreateIntent(intent) { return normalizeOutboxIntent(intent).commandType === CREATE; }
function isMutationIntent(intent) { return MUTATIONS.has(normalizeOutboxIntent(intent).commandType); }

function settleMutationReceipt(store, { clientCommandId, eventId, commandType, conversationId, messageId, revision } = {}) {
  const command = id(clientCommandId, "client command id");
  const event = id(eventId, "event id");
  const settledConversation = id(conversationId, "conversation id");
  const settledIntent = store.db.get(`SELECT * FROM outbox WHERE account_id = ? AND client_command_id = ?`, store.accountId, command);
  if (!settledIntent) return { settled: false, eventId: event };
  const intent = normalizeOutboxIntent(store._decrypt({ scopeId: settledIntent.scope_id, recordId: store._outboxRecord(settledIntent.id), value: settledIntent.payload_envelope_json }));
  const targetRevision = positive(revision, "revision");
  if (!MUTATIONS.has(intent.commandType) || intent.commandType !== commandType || settledIntent.conversation_id !== settledConversation
    || intent.messageId !== id(messageId, "message id") || targetRevision !== intent.expectedRevision + 1) {
    const error = new Error("Mutation receipt does not match durable intent");
    error.code = "COLLAB_OUTBOX_RECEIPT_INVALID";
    throw error;
  }
  store.db.run(`UPDATE outbox SET state = 'persisted', delivery_confirmed = 1, delivery_uncertain = 0, error_code = NULL, updated_at = ? WHERE account_id = ? AND id = ?`, store.now(), store.accountId, settledIntent.id);
  store.db.run(`INSERT INTO history_hydration (account_id, conversation_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id, conversation_id) DO NOTHING`, store.accountId, settledConversation, store.now());
  store.db.run(`INSERT INTO history_hydration_targets (account_id, conversation_id, message_id, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`, store.accountId, settledConversation, intent.messageId, targetRevision);
  return { settled: true, eventId: event, mutation: true };
}

module.exports = { CREATE, MUTATIONS, normalizeOutboxIntent, persistMessageMutation, isCreateIntent, isMutationIntent, settleMutationReceipt };
