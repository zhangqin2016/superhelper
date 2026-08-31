"use strict";
const { validOperationRequest, operationView, invalidOperationView, safeOperationErrorCode } = require("./message-operation-view");

function readMessageOperations(store, { conversationId, outboxIds, deviceId } = {}) {
  if (!validOperationRequest({ conversationId, outboxIds })) throw invalidOperationView();
  // Filter by account AND conversation before decrypting, including corrupt
  // foreign rows. No historical outbox scan or broadcast-body expansion.
  const rows = outboxIds.length ? store.db.all(`SELECT * FROM outbox WHERE account_id = ? AND conversation_id = ?
    AND id IN (${outboxIds.map(() => "?").join(",")}) LIMIT 200`, store.accountId, conversationId, ...outboxIds) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const operations = [], unavailableOutboxIds = [];
  for (const id of outboxIds) {
    const row = byId.get(id);
    if (!row) { unavailableOutboxIds.push(id); continue; }
    try {
      const intent = store._decrypt({ scopeId: row.scope_id, recordId: store._outboxRecord(id), value: row.payload_envelope_json });
      const commandType = intent.commandType == null ? "message.create" : intent.commandType;
      const mutation = commandType === "message.edit" || commandType === "message.revoke";
      if (intent.clientCommandId !== row.client_command_id || ![0, 1].includes(row.delivery_confirmed) || ![0, 1].includes(row.delivery_uncertain)) throw invalidOperationView();
      operations.push(operationView({ id: row.id, conversationId: row.conversation_id, clientCommandId: row.client_command_id, scopeId: row.scope_id,
        commandType, messageId: intent.messageId, expectedRevision: intent.expectedRevision, bodyText: intent.bodyText,
        state: row.state, attempts: row.attempts, deliveryConfirmed: Boolean(row.delivery_confirmed), deliveryUncertain: Boolean(row.delivery_uncertain),
        blockedBy: store.findOutboxPredecessor({ outboxId: row.id }), errorCode: safeOperationErrorCode(row.error_code),
        originalDeviceRequired: mutation ? !deviceId || !intent.originDeviceId || intent.originDeviceId !== deviceId
          : Boolean(deviceId && intent.originDeviceId && intent.originDeviceId !== deviceId) }));
    } catch { throw invalidOperationView(); }
  }
  return { ok: true, conversationId, operations, unavailableOutboxIds };
}
module.exports = { readMessageOperations };
