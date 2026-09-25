// The order a conversation is shown in — ONE definition for every screen.
//
// The stored conversation is not in display order: a question queued while
// the previous turn ran is recorded at admission, before that turn's answer;
// a turn's user and assistant rows may sit apart. The desktop's chat groups
// messages by turn, orders turns by their earliest timestamp, and puts the
// user's message before the assistant's within a turn. The phone showed the
// raw order and so put a question after its answer or beside another turn's
// (field case 2026-09-25). Both now order here.

export function messageTimestampMs(message = {}) {
  const parsed = Date.parse(message.timestamp || message.createdAt || message.record?.startedAt || "");
  return Number.isFinite(parsed) ? parsed : null;
}

// `timestampOf` lets a caller whose items carry the time differently (the
// phone's `ts` in ms) order the same way.
export function orderCommittedMessages(messages = [], { timestampOf = messageTimestampMs } = {}) {
  const turnInfo = new Map();
  messages.forEach((message, index) => {
    const key = message.turnId || `__i${index}`;
    const ts = timestampOf(message);
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
