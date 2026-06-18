export function messageKey(message, index) {
  return (message?.turnId ? `${message.role}:${message.turnId}` : null)
    || message?.id
    || `${message?.role || ""}:${message?.timestamp || index}:${index}`;
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
