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
