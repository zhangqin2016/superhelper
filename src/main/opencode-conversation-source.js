"use strict";

function metadataKey(message = {}) {
  return message.engineMessageId || message.record?.engineMessageId || message.id || "";
}

function buildMetadataIndex(messages = []) {
  const byEngineMessage = new Map();
  for (const message of messages || []) {
    const key = metadataKey(message);
    if (!key) continue;
    if (message.record || message.meta || message.failed || message.turnId) {
      byEngineMessage.set(key, message);
    }
  }
  return byEngineMessage;
}

function mergeMetadata(opencodeMessage, metadataMessage) {
  if (!metadataMessage) return opencodeMessage;
  const merged = { ...opencodeMessage };
  if (metadataMessage.turnId && !merged.turnId) merged.turnId = metadataMessage.turnId;
  if (metadataMessage.failed) merged.failed = true;
  if (metadataMessage.meta) {
    merged.meta = {
      ...(opencodeMessage.meta || {}),
      ...metadataMessage.meta,
    };
  }
  if (metadataMessage.record && opencodeMessage.role === "assistant") {
    merged.record = {
      ...metadataMessage.record,
      ...(opencodeMessage.record || {}),
      artifacts: metadataMessage.record.artifacts || opencodeMessage.record?.artifacts || [],
      fileChanges: metadataMessage.record.fileChanges || opencodeMessage.record?.fileChanges || [],
      resultBlocks: metadataMessage.record.resultBlocks || opencodeMessage.record?.resultBlocks || [],
      timeline: metadataMessage.record.timeline || opencodeMessage.record?.timeline || [],
      notices: metadataMessage.record.notices || opencodeMessage.record?.notices || [],
      processEvents: metadataMessage.record.processEvents || opencodeMessage.record?.processEvents || [],
      meta: {
        ...(opencodeMessage.record?.meta || {}),
        ...(metadataMessage.record.meta || {}),
        opencode: opencodeMessage.record?.meta?.opencode || metadataMessage.record.meta?.opencode || null,
      },
    };
  }
  return merged;
}

async function getConversationPageFromSource(ctx, sessionId, opts = {}) {
  const session = sessionId ? ctx.sessionManager.findById(sessionId) : ctx.sessionManager.getActive();
  if (!session) {
    return {
      ok: false,
      error: "NOT_FOUND",
      sessionId: sessionId || null,
      conversation: [],
      hasMore: false,
      before: null,
      nextBefore: null,
      total: 0,
    };
  }

  const fallback = () => ctx.sessionManager.getConversationPage(session.id, opts);
  let runner = ctx.runnerPool?.get?.(session.id);
  if ((!runner?.getConversationPage || !runner?.isAlive?.()) && session.agentResumeId) {
    try {
      const ensureConversationRunner =
        ctx.ensureConversationRunner ||
        ((targetCtx, targetSessionId) => require("./ipc-utils").ensureSessionRunner(targetCtx, targetSessionId, { spawn: true }));
      const ensured = await ensureConversationRunner(ctx, session.id);
      if (ensured?.runner) runner = ensured.runner;
    } catch {
      // Official OpenCode history is best-effort here. If the engine cannot be
      // started for a passive read, Lily's metadata/legacy store remains the
      // offline fallback.
    }
  }
  if (!runner?.getConversationPage || !runner?.isAlive?.()) return fallback();

  try {
    const page = await runner.getConversationPage(opts);
    const metadata = buildMetadataIndex(ctx.sessionManager.getConversation(session.id));
    return {
      ...page,
      projectId: session.projectId,
      conversation: (page.conversation || []).map((message) => {
        const key = metadataKey(message);
        return mergeMetadata(message, key ? metadata.get(key) : null);
      }),
    };
  } catch (err) {
    return {
      ...fallback(),
      source: "lily-fallback",
      warning: "OPENCODE_MESSAGES_UNAVAILABLE",
      detail: String(err?.message || err),
    };
  }
}

module.exports = {
  buildMetadataIndex,
  mergeMetadata,
  getConversationPageFromSource,
};
