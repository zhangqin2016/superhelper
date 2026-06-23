export function conversationMessageKey(message, index = 0) {
  const id = String(message?.id || message?.engineMessageId || "").trim();
  if (id) return `id:${id}`;
  if (message?.turnId && message?.role) return `turn:${message.role}:${message.turnId}`;
  return ["fallback", message?.role || "", message?.timestamp || "", message?.content || "", index].join(":");
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
