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

  commitAssistantMessage(sessionId, { text, failed = false, turnId, meta = null }) {
    const content = String(text || "").trim();
    if (!content && !failed) return null;
    const extra = {
      id: `msg_${crypto.randomUUID()}`,
      turnId,
      ...(failed ? { failed: true } : {}),
      ...(meta ? { meta } : {}),
    };
    this.sessionManager.pushMessageTo(sessionId, "assistant", content, null, extra);
    return extra;
  }

  removeLastAssistantMessage(sessionId) {
    return this.sessionManager.popLastAssistantMessage(sessionId);
  }

  getCommittedMessages(sessionId) {
    return this.sessionManager.findById(sessionId)?.messages || [];
  }
}

module.exports = { TranscriptStore };
