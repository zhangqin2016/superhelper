"use strict";

// Which answers a history read shows when a later round took over a turn: a
// replacement hides the answer it replaced; a delivery check continues it.
const { messageText } = require("./conversation-message-text");

// A turn whose answer the host superseded (a retry replaced it) stays hidden
// whichever source brings it back: its turn projection used to return it, so
// on reload the replaced answer stood again above its replacement (2026-09-30).
function withoutSupersededTurns(conversation = [], hostMessages = []) {
  const superseded = new Set((hostMessages || [])
    .filter((message) => message?.role === "assistant" && message.meta?.superseded === true && message.turnId)
    .map((message) => message.turnId));
  if (!superseded.size) return conversation;
  return conversation.filter((message) => !(message?.role === "assistant" && superseded.has(message.turnId)));
}

// A delivery check continues the answer it checks (continuesTurnId). Rounds
// recorded before that were stored as superseding it, which would now hide the
// deliverable behind a short QA report: read them as the continuation they were.
function withDeliveryCheckContinuations(hostMessages = [], projections = []) {
  const { isDeliveryCheckPrompt } = require("./document-delivery-recovery-prompt");
  const checks = new Set([...(hostMessages || []), ...(projections || [])]
    .filter((message) => message?.role === "user" && message.turnId && isDeliveryCheckPrompt(messageText(message)))
    .map((message) => message.turnId));
  if (!checks.size) return hostMessages;
  const sourceOf = new Map();
  for (const message of hostMessages) {
    const by = message?.meta?.supersededByTurnId;
    if (message?.role === "assistant" && message.meta?.superseded === true && checks.has(by)) sourceOf.set(by, message.turnId);
  }
  if (!sourceOf.size) return hostMessages;
  return hostMessages.map((message) => {
    if (message?.role !== "assistant") return message;
    if (message.meta?.superseded === true && sourceOf.has(message.meta.supersededByTurnId)) {
      return { ...message, meta: { ...message.meta, superseded: false } };
    }
    const source = sourceOf.get(message.turnId);
    if (!source || message.record?.meta?.continuesTurnId) return message;
    return { ...message, ...(message.record ? { record: { ...message.record, meta: { ...(message.record.meta || {}), continuesTurnId: source } } } : {}) };
  });
}

module.exports = { withDeliveryCheckContinuations, withoutSupersededTurns };
