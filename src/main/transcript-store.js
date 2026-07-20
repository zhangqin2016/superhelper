"use strict";

const crypto = require("node:crypto");

class TranscriptStore {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  commitUserMessage(sessionId, { text, files = null, turnId, steer = false, steerSeq = null }) {
    const extra = { id: `msg_${crypto.randomUUID()}`, turnId };
    // A steered ("插话") message is a SECOND user message in the same turn; persist the
    // marker via meta (the store's durable channel) so it survives reload as a distinct
    // bubble instead of collapsing into the turn's original user message.
    if (steer) extra.meta = { steer: true, steerSeq };
    this.sessionManager.pushMessageTo(sessionId, "user", String(text || ""), files, extra);
    return extra;
  }

  removeLastAssistantMessage(sessionId) {
    return this.sessionManager.popLastAssistantMessage(sessionId);
  }

  supersedeAssistantTurn(sessionId, turnId, supersededByTurnId = "") {
    const messages = this.sessionManager.getConversation?.(sessionId) || [];
    const target = [...messages].reverse().find(
      (message) => message?.role === "assistant" && message?.turnId === turnId && !message?.meta?.superseded,
    );
    if (!target?.id || typeof this.sessionManager.updateMessageMeta !== "function") return null;
    return this.sessionManager.updateMessageMeta(sessionId, target.id, (meta) => ({
      ...meta,
      superseded: true,
      supersededByTurnId: String(supersededByTurnId || ""),
    }));
  }

  getCommittedMessages(sessionId) {
    return this.sessionManager.getConversation(sessionId) || [];
  }
}

module.exports = { TranscriptStore };
