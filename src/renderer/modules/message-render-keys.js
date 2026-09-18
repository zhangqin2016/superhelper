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

/** The turn a message key belongs to, for keys of the form `role:turnId`. */
function turnIdFromKey(key = "") {
  const parts = String(key).split(":");
  return parts.length >= 2 ? parts[1] : "";
}

/**
 * Drop the DOM articles that left the render window.
 *
 * Eviction works on TURN identity, not only on message keys. A live-turn
 * article carries no message key, so a key-only sweep left it behind when its
 * committed card was evicted — a card stranded in the middle of history with
 * nothing left pointing at it. Every article that stands for a turn declares
 * that turn, so evicting a turn evicts all of it. [gate: one-turn-one-article]
 */
export function removeCommittedArticlesByKeys(listEl, evictedKeys = []) {
  if (!listEl?.querySelectorAll || !evictedKeys.length) return;
  const evicted = new Set(evictedKeys);
  const evictedTurns = new Set([...evicted].map(turnIdFromKey).filter(Boolean));
  const surviving = new Set();
  for (const node of listEl.querySelectorAll("[data-message-key]")) {
    if (evicted.has(node.dataset?.messageKey)) node.remove();
    else if (node.dataset?.turnId) surviving.add(node.dataset.turnId);
  }
  if (!evictedTurns.size) return;
  for (const node of listEl.querySelectorAll("[data-turn-id]")) {
    const turnId = node.dataset?.turnId || "";
    // Only turns with nothing left in the window: a turn whose committed card
    // survived still owns its place, and a running turn sits at the bottom of
    // the window, never in the evicted range.
    if (evictedTurns.has(turnId) && !surviving.has(turnId)) node.remove();
  }
}
