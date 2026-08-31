"use strict";

const { isConversationRevoked } = require("./access-revocation");

const SAFE_CODES = new Set([
  "COLLAB_EDIT_DRAFT_CONFLICT", "COLLAB_EDIT_DRAFT_BASE_MISMATCH", "COLLAB_MESSAGE_EDIT_FORBIDDEN",
  "COLLABORATION_INVALID_INPUT", "COLLABORATION_NOT_FOUND",
]);

function createEditDraftService({ store, enqueueSync, assertActive, isStopped, stoppedResult }) {
  const accessFailure = (conversationId) => {
    assertActive();
    if (isConversationRevoked(store, conversationId)) return { ok: false, code: "COLLAB_ACCESS_REVOKED", retryable: false };
    if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
    return null;
  };
  const run = (conversationId, operation) => {
    if (isStopped()) return stoppedResult();
    return enqueueSync(() => accessFailure(conversationId) || operation())
      .then((result) => accessFailure(conversationId) || result)
      .catch((error) => {
        if (isStopped()) return stoppedResult();
        return { ok: false, code: SAFE_CODES.has(error?.code) ? error.code : "COLLABORATION_UNAVAILABLE", retryable: false };
      });
  };
  return {
    getEditDraft({ conversationId, messageId } = {}) {
      return run(conversationId, () => ({ ok: true, conversationId, messageId, draft: store.getEditDraft({ conversationId, messageId }) }));
    },
    saveEditDraft({ conversationId, messageId, bodyText, baseRevision, expectedGeneration } = {}) {
      return run(conversationId, () => ({ ok: true, conversationId, messageId,
        ...store.saveEditDraft({ conversationId, messageId, bodyText, baseRevision, expectedGeneration }) }));
    },
    clearEditDraft({ conversationId, messageId, expectedGeneration } = {}) {
      return run(conversationId, () => ({ ok: true, conversationId, messageId,
        cleared: store.clearEditDraft({ conversationId, messageId, expectedGeneration }) }));
    },
  };
}

module.exports = { createEditDraftService };
