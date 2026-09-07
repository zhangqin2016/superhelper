"use strict";

const { messageMetadata } = require("./message-intent");
const { validOperationRequest } = require("./message-operation-view");
const { isConversationRevoked } = require("./access-revocation");

/** Read adapters share the service's durable lane and stop/account fences. */
function createMessageCacheReads({ store, deviceId, enqueueSync, assertActive, isStopped, stoppedResult }) {
  return {
    getDraft({ conversationId } = {}) {
      if (isStopped()) return stoppedResult();
      if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
      const draft = store.getDraft({ conversationId, draftId: "composer" });
      return { ok: true, text: draft?.text || "", ...messageMetadata(draft || {}) };
    },
    readMessages({ conversationId, messageIds } = {}) {
      if (isStopped()) return stoppedResult();
      if (!Array.isArray(messageIds) || messageIds.length > 200 || messageIds.some((id) => typeof id !== "string" || !id || id.length > 200)) return { ok: false, code: "COLLABORATION_INVALID_INPUT" };
      return enqueueSync(() => {
        if (!store.getConversation({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND" };
        const messages = [], unavailableMessageIds = [];
        for (const messageId of messageIds) {
          const row = store.getMessage({ conversationId, messageId });
          if (row) messages.push(row); else unavailableMessageIds.push(messageId);
        }
        return { ok: true, messages, unavailableMessageIds };
      });
    },
    readMessageOperations(input = {}) {
      if (isStopped()) return stoppedResult();
      const request = validOperationRequest(input);
      if (!request) return { ok: false, code: "COLLABORATION_INVALID_INPUT" };
      const accountId = store.accountId;
      return enqueueSync(() => {
        const accessFailure = () => {
          assertActive();
          if (store.accountId !== accountId) return { ok: false, code: "COLLAB_ACCOUNT_CHANGED" };
          if (isConversationRevoked(store, request.conversationId)) return { ok: false, code: "COLLAB_ACCESS_REVOKED" };
          if (!store.getConversation?.({ conversationId: request.conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND" };
          return null;
        };
        const beforeRead = accessFailure();
        if (beforeRead) return beforeRead;
        const result = store.readMessageOperations({ ...request, deviceId });
        return accessFailure() || result;
      });
    },
  };
}

module.exports = { createMessageCacheReads };
