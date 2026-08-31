"use strict";

const CREATE = "message.create";
const EDIT = "message.edit";
const REVOKE = "message.revoke";
const { messageMetadata, messageIdentifier } = require("./message-intent");

function unsupportedCommand() {
  const error = new Error("Unsupported collaboration outbox command");
  error.code = "COLLAB_OUTBOX_COMMAND_UNSUPPORTED";
  return error;
}
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function strictInteger(value) { return Number.isSafeInteger(value) && value > 0; }

function commandFor(item, deviceId) {
  const base = { deviceId, conversationId: item?.conversationId, clientCommandId: item?.clientCommandId };
  if (item?.commandType === CREATE || item?.commandType == null) {
    const metadata = messageMetadata(item);
    return { action: "send", ...base, bodyText: item.bodyText,
      ...(metadata.replyToMessageId ? { replyToMessageId: metadata.replyToMessageId } : {}),
      ...(metadata.mentionUserIds.length ? { mentionUserIds: metadata.mentionUserIds } : {}),
      ...(Array.isArray(item.attachmentIds) && item.attachmentIds.length ? { attachmentIds: item.attachmentIds, attachmentPurpose: item.attachmentPurpose } : {}) };
  }
  if (item.commandType === EDIT) return { action: "edit", ...base, messageId: item.messageId, expectedRevision: item.expectedRevision, bodyText: item.bodyText };
  if (item.commandType === REVOKE) return { action: "revoke", ...base, messageId: item.messageId, expectedRevision: item.expectedRevision };
  throw unsupportedCommand();
}

function committedView(item, response) {
  const commandType = item?.commandType || CREATE;
  const result = response?.result, message = result?.message;
  if (response?.ok !== true || !nonEmpty(result?.eventId) || !nonEmpty(message?.id) || !nonEmpty(message?.conversationId) || !strictInteger(message?.seq)) return null;
  // A create receipt is the immutable original creation result, never a
  // current edit/revoke projection that happens to share this conversation.
  if (commandType === CREATE && (message.conversationId !== item.conversationId || !messageIdentifier(message.id) || !messageIdentifier(result.eventId)
    || message.revision !== 1 || message.revoked !== false)) return null;
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
    async submit(item) {
      const committed = committedView(item, await client.submitMessage(commandFor(item, deviceId)));
      if (!committed && (item?.commandType || CREATE) === CREATE) throw Object.assign(new Error("Collaboration create response is not commit evidence"), { code: "COLLAB_RESPONSE_UNKNOWN" });
      return committed;
    },
    async lookupReceipt({ clientCommandId, commandType = CREATE, conversationId, messageId, expectedRevision }) {
      const receipt = await client.lookupCommandReceipt({ deviceId, clientCommandId, commandType, conversationId, messageId, expectedRevision });
      // Only a well-typed server unknown response can reach the generic
      // adapter's legacy-compatible replay predicate, for every command type.
      if (receipt?.state === "unknown") {
        if (receipt.ok !== true || receipt.committed !== false || receipt.deliveryUnknown !== true
          || (Object.hasOwn(receipt, "pending") && receipt.pending !== false)
          || ["eventId", "messageId", "sequence", "eventSequence", "commandType", "conversationId", "revision", "revoked"].some(key => receipt[key] != null)) {
          throw Object.assign(new Error("Collaboration unknown receipt is not replay evidence"), { code: "COLLAB_RESPONSE_UNKNOWN" });
        }
        return receipt;
      }
      // Completed mutations retain their existing typed settlement contract.
      // Creates must be strict before reaching the generic adapter boundary.
      if (commandType !== CREATE) return receipt;
      if (receipt?.ok !== true || receipt.state !== "completed" || receipt.committed !== true
        || receipt.commandType !== CREATE || receipt.conversationId !== conversationId
        || !messageIdentifier(receipt.messageId) || !messageIdentifier(receipt.eventId)
        || receipt.revision !== 1 || (Object.hasOwn(receipt, "revoked") && receipt.revoked !== false)
        || !strictInteger(receipt.eventSequence) || !strictInteger(receipt.sequence) || receipt.eventSequence !== receipt.sequence
        || (Object.hasOwn(receipt, "pending") && receipt.pending !== false)
        || (Object.hasOwn(receipt, "deliveryUnknown") && receipt.deliveryUnknown !== false)) {
        throw Object.assign(new Error("Collaboration create receipt is not commit evidence"), { code: "COLLAB_RESPONSE_UNKNOWN" });
      }
      return receipt;
    },
  };
}

module.exports = { createCollaborationOutboxTransport, commandFor, committedView };
