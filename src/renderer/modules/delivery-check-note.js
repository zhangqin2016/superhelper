// An answer a delivery check continues drops its "自动检查未全部完成" note: the
// check below it reports the outcome (and carries its own note if something is
// still unverified). The note is removed only where it is the exact string the
// platform appended (record.meta.evidenceGate.deliveryNote), so nothing the
// model wrote is ever touched. One answer, one verdict (2026-09-30).
function withoutSuffix(text, note) {
  const value = String(text ?? "");
  return value.endsWith(note) ? value.slice(0, value.length - note.length) : value;
}

function withoutNote(message, note) {
  const record = message.record || {};
  const timeline = Array.isArray(record.timeline) ? record.timeline : null;
  const last = timeline ? timeline.length - 1 : -1;
  return {
    ...message,
    content: withoutSuffix(message.content, note),
    record: {
      ...record,
      assistantText: withoutSuffix(record.assistantText, note),
      ...(record.answerText ? { answerText: withoutSuffix(record.answerText, note) } : {}),
      ...(timeline ? { timeline: timeline.map((entry, index) => (index === last && entry?.kind === "text"
        ? { ...entry, text: withoutSuffix(entry.text, note) } : entry)) } : {}),
    },
  };
}

/** The committed messages with each continued answer's appended note removed. */
export function resolveContinuedDeliveryNotes(messages = []) {
  const continued = new Set(messages
    .map((message) => message?.role === "assistant" && message.record?.meta?.continuesTurnId)
    .filter(Boolean));
  if (!continued.size) return messages;
  let changed = false;
  const out = messages.map((message) => {
    const note = message?.record?.meta?.evidenceGate?.deliveryNote;
    if (message?.role !== "assistant" || !note || !continued.has(message.turnId || message.record?.turnId)) return message;
    if (!String(message.content ?? "").endsWith(note) && !String(message.record?.assistantText ?? "").endsWith(note)) return message;
    changed = true;
    return withoutNote(message, note);
  });
  return changed ? out : messages;
}
