"use strict";

const CREATE = "message.create";
const EDIT = "message.edit";
const REVOKE = "message.revoke";

function unsupportedCommand() {
  const error = new Error("Unsupported collaboration outbox command");
  error.code = "COLLAB_OUTBOX_COMMAND_UNSUPPORTED";
  return error;
}
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function strictInteger(value) { return Number.isSafeInteger(value) && value > 0; }

function commandFor(item, deviceId) {
  const base = { deviceId, conversationId: item?.conversationId, clientCommandId: item?.clientCommandId };
  if (item?.commandType === CREATE || item?.commandType == null) return { action: "send", ...base, bodyText: item.bodyText,
    ...(Array.isArray(item.attachmentIds) && item.attachmentIds.length ? { attachmentIds: item.attachmentIds, attachmentPurpose: item.attachmentPurpose } : {}) };
  if (item.commandType === EDIT) return { action: "edit", ...base, messageId: item.messageId, expectedRevision: item.expectedRevision, bodyText: item.bodyText };
  if (item.commandType === REVOKE) return { action: "revoke", ...base, messageId: item.messageId, expectedRevision: item.expectedRevision };
  throw unsupportedCommand();
}

function committedView(item, response) {
  const commandType = item?.commandType || CREATE;
  const result = response?.result, message = result?.message;
  if (response?.ok !== true || !nonEmpty(result?.eventId) || !nonEmpty(message?.id) || !nonEmpty(message?.conversationId) || !strictInteger(message?.seq)) return null;
  if (commandType === EDIT || commandType === REVOKE) {
    if (message.id !== item.messageId || message.conversationId !== item.conversationId || !strictInteger(message.revision)
      || message.revision !== item.expectedRevision + 1 || commandType === REVOKE && message.revoked !== true || commandType === EDIT && message.revoked === true) return null;
  }
  return { committed: true, state: "completed", commandType, eventId: result.eventId, eventSequence: message.seq, sequence: message.seq,
    conversationId: message.conversationId, messageId: message.id, ...(strictInteger(message.revision) ? { revision: message.revision } : {}),
    ...(message.revoked === true ? { revoked: true } : {}) };
}

function createCollaborationOutboxTransport({ client, deviceId } = {}) {
  if (!client || typeof client.submitMessage !== "function") throw new TypeError("A collaboration client is required.");
  return {
    async submit(item) { return committedView(item, await client.submitMessage(commandFor(item, deviceId))); },
    lookupReceipt: ({ clientCommandId, commandType, conversationId, messageId, expectedRevision }) => client.lookupCommandReceipt({
      deviceId, clientCommandId, commandType, conversationId, messageId, expectedRevision,
    }),
  };
}

module.exports = { createCollaborationOutboxTransport, commandFor, committedView };
