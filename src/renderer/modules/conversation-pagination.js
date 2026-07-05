export function conversationMessageKey(message, index = 0) {
  const id = String(message?.id || message?.engineMessageId || "").trim();
  if (id) return `id:${id}`;
  if (message?.turnId && message?.role) return `turn:${message.role}:${message.turnId}`;
  return ["fallback", message?.role || "", message?.timestamp || "", message?.content || "", index].join(":");
}

function stableConversationMessageKey(message) {
  const id = String(message?.id || message?.engineMessageId || "").trim();
  if (id) return `id:${id}`;
  if (message?.turnId && message?.role) return `turn:${message.role}:${message.turnId}`;
  return "";
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedContent(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function findEquivalentMessageIndex(messages, message) {
  const key = stableConversationMessageKey(message);
  if (key) {
    const index = messages.findIndex((item) => stableConversationMessageKey(item) === key);
    if (index >= 0) return index;
  }

  const text = normalizedContent(message?.content || message?.text || "");
  if (!message?.role || !text) return -1;
  const messageTime = timestampMs(message.timestamp);
  return messages.findIndex((item) => {
    if (item?.role !== message.role) return false;
    if (normalizedContent(item.content || item.text || "") !== text) return false;
    const itemTime = timestampMs(item.timestamp);
    if (!Number.isFinite(messageTime) || !Number.isFinite(itemTime)) return true;
    return Math.abs(itemTime - messageTime) <= 10 * 60 * 1000;
  });
}

function mergeConversationMessage(existing = {}, incoming = {}) {
  return {
    ...existing,
    ...incoming,
    files: incoming.files || existing.files,
    turnId: incoming.turnId || existing.turnId,
    record: incoming.record || existing.record || null,
    failed: Boolean(existing.failed || incoming.failed),
    meta: {
      ...(existing.meta || {}),
      ...(incoming.meta || {}),
    },
  };
}

export function mergeLatestConversationPage(localMessages = [], officialMessages = []) {
  const merged = Array.isArray(localMessages) ? localMessages.slice() : [];
  for (const message of Array.isArray(officialMessages) ? officialMessages : []) {
    if (!message?.role) continue;
    const index = findEquivalentMessageIndex(merged, message);
    if (index < 0) {
      merged.push(message);
      continue;
    }
    merged[index] = mergeConversationMessage(merged[index], message);
  }
  return merged.sort((a, b) => {
    const at = timestampMs(a?.timestamp) ?? 0;
    const bt = timestampMs(b?.timestamp) ?? 0;
    if (at !== bt) return at - bt;
    if (a?.turnId && b?.turnId && a.turnId === b.turnId && a.role !== b.role) {
      return a.role === "user" ? -1 : 1;
    }
    return 0;
  });
}

export function mergeOlderConversationPage(olderMessages = [], currentMessages = []) {
  const merged = [];
  const indexByKey = new Map();
  const add = (message, preferExisting = false) => {
    const key = conversationMessageKey(message, merged.length);
    const existing = indexByKey.get(key);
    if (existing !== undefined) {
      if (!preferExisting) merged[existing] = message;
      return;
    }
    indexByKey.set(key, merged.length);
    merged.push(message);
  };
  for (const message of Array.isArray(olderMessages) ? olderMessages : []) add(message, true);
  for (const message of Array.isArray(currentMessages) ? currentMessages : []) add(message, false);
  return merged;
}

export function shouldContinueLoadingOlder(input = {}) {
  if (!input.hasMore) return false;
  if (Number(input.pageSize || 0) <= 0) return false;
  return Number(input.mergedCount || 0) <= Number(input.previousCount || 0);
}
