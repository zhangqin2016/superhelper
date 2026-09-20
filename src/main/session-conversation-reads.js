"use strict";

const { withFreshArtifacts } = require("./artifact-freshness");
const { projectConversationForDisplay } = require("./conversation-display-projection");

module.exports = {
  async getTurnUserRevisionsAsync(sessionId, turnId) {
    const session = this._find(sessionId);
    if (!session || !turnId) return [];
    this._ensureImported(session);
    return this._store().getTurnUserRevisionsAsync(sessionId, turnId);
  },
  async getAssistantForTurnAsync(sessionId, turnId) {
    const session = this._find(sessionId);
    if (!session || !turnId) return null;
    this._ensureImported(session);
    return this._store().getAssistantForTurnAsync(sessionId, turnId);
  },
  async getRecentConversationAsync(sessionId, { limit = 120 } = {}) {
    const session = this._find(sessionId);
    if (!session) return [];
    this._ensureImported(session);
    return (await this._store().getPageAsync(session.id, { limit })).conversation;
  },

  async getConversationPageAsync(sessionId, opts = {}) {
    const session = sessionId ? this._find(sessionId) : this.getActive();
    if (!session) return this.getConversationPage(sessionId, opts);
    this._ensureImported(session);
    const page = await this._store().getPageAsync(session.id, { ...opts, workspacePath: this.pm?.find?.(session.projectId)?.path || "" });
    return this._conversationPageFromRead(session, page);
  },

  _conversationPageFromRead(session, page) {
    session.messageCount = page.total;
    const fresh = withFreshArtifacts(page.conversation, this.pm?.find?.(session.projectId)?.path || "");
    return {
      ok: true, sessionId: session.id, projectId: session.projectId, ...page,
      conversation: projectConversationForDisplay(fresh.conversation),
    };
  },
};
