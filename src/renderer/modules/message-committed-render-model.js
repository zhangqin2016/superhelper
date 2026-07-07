export const COMMITTED_RENDER_CHUNK = 5;
export const COMMITTED_INITIAL_WINDOW = 80;
export const COMMITTED_WINDOW_THRESHOLD = 160;

function messageTimestampMs(message = {}) {
  const parsed = Date.parse(message.timestamp || message.createdAt || message.record?.startedAt || "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function orderCommittedMessages(messages = []) {
  const turnInfo = new Map();
  messages.forEach((message, index) => {
    const key = message.turnId || `__i${index}`;
    const ts = messageTimestampMs(message);
    const existing = turnInfo.get(key);
    if (!existing) {
      turnInfo.set(key, { firstSeen: index, ts });
      return;
    }
    if (ts != null && (existing.ts == null || ts < existing.ts)) existing.ts = ts;
  });
  const roleRank = (role) => (role === "user" ? 0 : role === "assistant" ? 1 : 2);
  return messages
    .map((message, index) => ({ message, index, key: message.turnId || `__i${index}` }))
    .sort((a, b) => {
      const left = turnInfo.get(a.key) || { firstSeen: a.index, ts: null };
      const right = turnInfo.get(b.key) || { firstSeen: b.index, ts: null };
      if (left.ts != null && right.ts != null && left.ts !== right.ts) return left.ts - right.ts;
      if (left.ts != null && right.ts == null) return -1;
      if (left.ts == null && right.ts != null) return 1;
      if (left.firstSeen !== right.firstSeen) return left.firstSeen - right.firstSeen;
      const roleDelta = roleRank(a.message.role) - roleRank(b.message.role);
      if (roleDelta !== 0) return roleDelta;
      return a.index - b.index;
    })
    .map((entry) => entry.message);
}

export function committedMessagesForRender(messages = [], opts = {}) {
  if (!Array.isArray(messages)) return [];
  const ordered = orderCommittedMessages(messages);
  if (opts.preserveScroll) return ordered;
  if (ordered.length <= COMMITTED_WINDOW_THRESHOLD) return ordered;
  return ordered.slice(-COMMITTED_INITIAL_WINDOW);
}

export function isCommittedRenderCurrent(input = {}) {
  if (!input.hasSessionView) return false;
  if (!input.hasRenderedContent) return false;
  if (!input.renderedKeyCount) return false;
  if (input.renderedKeyCount !== input.renderMessageCount) return false;
  return Number(input.unrenderedCount || 0) === 0;
}

export function shouldSkipCommittedAssistantForLiveTurn(runtime = {}, message = {}) {
  if (message.role !== "assistant") return false;
  if (message.meta?.scheduledDraft) return false;
  return Boolean(message.turnId && runtime.liveTurn?.turnId === message.turnId);
}

export function copyActionText(message = {}) {
  return String(message?.content || "").trim();
}

export function formatScheduledDraftDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function scheduledDraftPreviewModel(message = {}) {
  const scheduled = message?.meta?.scheduledDraft || {};
  const draft = scheduled.draft || {};
  return {
    messageId: message?.id || "",
    created: scheduled.status === "created",
    title: draft.title || "",
    scheduleText: draft.scheduleText || "",
    nextRunAt: draft.nextRunAt || scheduled.task?.nextRunAt || "",
  };
}

export function liveInsertAnchorTurnId(runtime = {}) {
  const live = runtime.liveTurn;
  if (!live?.turnId || live.final) return "";
  if (!runtime.turnId || runtime.turnId !== live.turnId) return "";
  return live.turnId;
}

export function shouldShowRetryAction(message = {}) {
  return Boolean(message?.failed || message?.record?.terminal === "turn.stalled");
}

export function isCurrentRetryTarget(committedMessages = [], message = {}) {
  if (!Array.isArray(committedMessages) || committedMessages.length === 0) return false;
  const last = committedMessages[committedMessages.length - 1];
  if (last === message) return true;
  return Boolean(last?.turnId != null && last.turnId === message?.turnId);
}

export function rewindActionTarget(message = {}) {
  const turnId = message?.turnId || message?.record?.turnId || "";
  const engineMessageId = message?.record?.engineMessageId || "";
  if (!turnId || !engineMessageId) return null;
  return { turnId, engineMessageId };
}

export function buildMinimapItems(runtime = {}) {
  try {
    return orderCommittedMessages(runtime?.committedMessages || [])
      .filter((message) => message && message.role === "user")
      .map((message) => ({ role: "user", turnId: message.turnId || "", label: message.content || "" }));
  } catch {
    return [];
  }
}
