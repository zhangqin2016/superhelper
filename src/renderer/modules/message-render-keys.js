export function messageKey(message, index) {
  if (message?.turnId && message?.role) {
    if (message.steer || message.meta?.steer) {
      const fallback = normalizedMessageText(message) || index;
      const seq = message.steerSeq ?? message.meta?.steerSeq ?? fallback;
      return `${message.role}:${message.turnId}:steer:${seq}`;
    }
    return `${message.role}:${message.turnId}`;
  }
  return message?.id || `${message?.role || ""}:${message?.timestamp || index}:${index}`;
}

function normalizedMessageText(message = {}) {
  return String(message.content || message.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function collectUnrenderedCommittedMessages(messages, keys) {
  const pending = [];
  for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const key = messageKey(message, index);
    if (keys.has(key)) continue;
    keys.add(key);
    pending.push({ key, message });
  }
  return pending;
}

// Keys of previously-rendered messages that fall outside the current render
// window (the unloaded top end). `keys` is updated in place so bookkeeping and
// DOM eviction stay consistent in one pass.
export function collectEvictedMessageKeys(messages, keys) {
  const keep = new Set((Array.isArray(messages) ? messages : []).map((message, index) => messageKey(message, index)));
  const evicted = [];
  for (const key of keys || []) {
    if (keep.has(key)) continue;
    keys.delete(key);
    evicted.push(key);
  }
  return evicted;
}

// Drop the DOM articles whose message keys were evicted from the window. Keyed
// lookup only — live-turn articles carry no data-message-key and are untouched.
export function removeCommittedArticlesByKeys(listEl, evictedKeys = []) {
  if (!listEl?.querySelectorAll || !evictedKeys.length) return;
  const evicted = new Set(evictedKeys);
  for (const node of listEl.querySelectorAll("[data-message-key]")) {
    if (evicted.has(node.dataset?.messageKey)) node.remove();
  }
}
