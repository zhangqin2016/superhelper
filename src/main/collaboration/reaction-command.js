"use strict";

const { applyReaction, reactionsForMessages } = require("./message-reactions");

/**
 * The reaction command, factored out of the service so the service stays a
 * wiring layer.
 *
 * Optimistic on purpose: the local projection flips before the durable command
 * is submitted, so a chip responds to the tap instead of waiting for a round
 * trip. The command is the source of truth and the next sync reconciles it —
 * including correcting the flip if the server refused.
 *
 * There is deliberately no `expectedRevision`: a reaction is not a message
 * revision, so it must not enter the edit/revoke conflict path.
 */
function createReactionCommand({ store, getOutbox, deviceId = "", isStopped, stoppedResult, onChanged = () => {} } = {}) {
  return async function react({ conversationId, messageId, clientCommandId, emoji, active } = {}) {
    if (isStopped()) return stoppedResult();
    const outbox = getOutbox();
    if (!outbox || !store.getMessage?.({ conversationId, messageId })) {
      return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
    }
    const on = active !== false;
    const existing = store.getOutbox?.({ outboxId: clientCommandId });
    if (existing) {
      // A reused key must describe the SAME transition, or it is a collision.
      if (existing.commandType !== "message.reaction" || existing.conversationId !== conversationId
        || existing.messageId !== messageId || existing.emoji !== emoji || (existing.active !== false) !== on) {
        return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false };
      }
      return { ok: true, state: existing.state, clientCommandId: existing.clientCommandId };
    }
    if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
    let persisted;
    try {
      persisted = store.persistMessageMutation({
        commandType: "message.reaction", conversationId, messageId, clientCommandId,
        emoji, active: on, ...(deviceId ? { originDeviceId: deviceId } : {}),
      });
    } catch {
      return { ok: false, code: "COLLAB_REACTION_INVALID", retryable: false };
    }
    const wasActive = reactionsForMessages(store, [messageId])[messageId]?.some(entry => entry.emoji === emoji && entry.mine) === true;
    applyReaction(store, { conversationId, messageId, userId: store.accountId, emoji, active: on });
    onChanged();
    let result;
    try { result = await outbox.submit(persisted.outboxId); }
    catch (error) {
      if (isStopped()) return stoppedResult();
      const pending = store.getOutbox({ outboxId: persisted.outboxId });
      if (pending?.state === "failed" && !pending.deliveryUncertain) {
        // A definitive rejection will never produce a correcting sync event.
        // Do not undo a newer local transition for the same emoji.
        const latest = store.listOutbox().filter(item => item.conversationId === conversationId).map(item => store.getOutbox({ outboxId: item.id })).filter(item => item.commandType === "message.reaction" && item.conversationId === conversationId && item.messageId === messageId && item.emoji === emoji).at(-1);
        if (latest?.id === persisted.outboxId) applyReaction(store, { conversationId, messageId, userId: store.accountId, emoji, active: wasActive });
        outbox.skip(persisted.outboxId); // known unsent: never block later chat messages
      }
      onChanged();
      throw error;
    }
    if (isStopped()) return stoppedResult();
    onChanged();
    return { ok: true, ...result };
  };
}

module.exports = { createReactionCommand };
