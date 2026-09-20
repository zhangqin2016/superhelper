"use strict";

// Engine assistant IDs and host turn IDs are different identities. The engine's
// parent user message is the authoritative bridge, including empty aborts.
function bindHistoryOwnership(messages, localMessages, mergeMetadata) {
  const turnsByUser = new Map();
  const assistantsByTurn = new Map();
  for (const message of localMessages) {
    if (message.role === "assistant" && message.turnId) assistantsByTurn.set(message.turnId, message);
  }
  for (const message of messages) {
    if (message.role === "user" && message.turnId) {
      turnsByUser.set(message.engineMessageId || message.id, message.turnId);
    }
  }
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const parent = message.record?.meta?.opencode?.parentMessageId;
    const turnId = message.turnId || turnsByUser.get(parent);
    if (!turnId) return message;
    const owned = { ...message, turnId };
    const local = assistantsByTurn.get(turnId);
    return local ? mergeMetadata(owned, local) : owned;
  });
}

module.exports = { bindHistoryOwnership };
