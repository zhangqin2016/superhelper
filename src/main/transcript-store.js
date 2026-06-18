"use strict";

const crypto = require("node:crypto");

class TranscriptStore {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  commitUserMessage(sessionId, { text, files = null, turnId }) {
    const extra = { id: `msg_${crypto.randomUUID()}`, turnId };
    this.sessionManager.pushMessageTo(sessionId, "user", String(text || ""), files, extra);
    return extra;
  }

  removeLastAssistantMessage(sessionId) {
    return this.sessionManager.popLastAssistantMessage(sessionId);
  }

  getCommittedMessages(sessionId) {
    return this.sessionManager.getConversation(sessionId) || [];
  }
}

module.exports = { TranscriptStore };
