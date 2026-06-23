"use strict";

function metadataKey(message = {}) {
  return message.engineMessageId || message.record?.engineMessageId || message.id || "";
}

const USER_TIME_MATCH_WINDOW_MS = 10 * 60 * 1000;

const INJECTED_USER_PROMPT_MARKERS = [
  "# 智能工作台全局说明",
  "## 身份问答（必读）",
  "不要自称 Claude、Claude Code 或 Anthropic 产品",
  "[Session Resume Notice]",
  "[Task Contract]",
  "LILY_TASK_CONTRACT",
];

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function messageText(message = {}) {
  return String(message.content || message.text || "");
}

function isInjectedUserPromptText(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return INJECTED_USER_PROMPT_MARKERS.some((marker) => value.includes(marker));
}

function localUserDisplayMessages(messages = []) {
  return (messages || [])
    .filter((message) => message?.role === "user")
    .filter((message) => {
      const text = messageText(message).trim();
      return text && !isInjectedUserPromptText(text);
    });
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

function findLocalUserForOfficial(officialMessage, localUsers, usedIndexes, fallbackIndexRef) {
  const officialTs = timestampMs(officialMessage?.timestamp);
  if (Number.isFinite(officialTs)) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < localUsers.length; i += 1) {
      if (usedIndexes.has(i)) continue;
      const candidateTs = timestampMs(localUsers[i]?.timestamp);
      if (!Number.isFinite(candidateTs)) continue;
      const distance = Math.abs(candidateTs - officialTs);
      if (distance <= USER_TIME_MATCH_WINDOW_MS && distance < bestDistance) {
        bestIndex = i;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      usedIndexes.add(bestIndex);
      return localUsers[bestIndex];
    }
  }

  const officialText = messageText(officialMessage);
  if (!isInjectedUserPromptText(officialText)) return null;

  while (fallbackIndexRef.index < localUsers.length && usedIndexes.has(fallbackIndexRef.index)) {
    fallbackIndexRef.index += 1;
  }
  if (fallbackIndexRef.index >= localUsers.length) return null;
  const index = fallbackIndexRef.index;
  fallbackIndexRef.index += 1;
  usedIndexes.add(index);
  return localUsers[index];
}

function mergeUserDisplayText(opencodeMessages = [], localMessages = []) {
  const localUsers = localUserDisplayMessages(localMessages);
  if (!localUsers.length) return opencodeMessages;

  const usedIndexes = new Set();
  const fallbackIndexRef = { index: Math.max(0, localUsers.length - opencodeMessages.filter((m) => m?.role === "user").length) };
  return (opencodeMessages || []).map((message) => {
    if (message?.role !== "user") return message;
    const local = findLocalUserForOfficial(message, localUsers, usedIndexes, fallbackIndexRef);
    if (!local) return message;
    return {
      ...message,
      content: messageText(local),
      files: local.files,
      turnId: local.turnId || message.turnId,
      meta: {
        ...(message.meta || {}),
        displaySource: "lily-raw-user",
        opencodeEnginePromptHidden: isInjectedUserPromptText(messageText(message)),
      },
    };
  });
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
    const localConversation = ctx.sessionManager.getConversation(session.id);
    const metadata = buildMetadataIndex(localConversation);
    const conversation = mergeUserDisplayText(page.conversation || [], localConversation).map((message) => {
      const key = metadataKey(message);
      return mergeMetadata(message, key ? metadata.get(key) : null);
    });
    return {
      ...page,
      projectId: session.projectId,
      conversation,
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
  isInjectedUserPromptText,
  mergeMetadata,
  mergeUserDisplayText,
  getConversationPageFromSource,
};
