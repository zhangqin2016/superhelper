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

// The comparable text of a message. A rich assistant turn often keeps its answer
// in `record.assistantText` (result/content blocks) with an EMPTY top-level
// `content`, while the official OpenCode refresh of the same turn carries the
// plain text in `content`. Comparing only `content`/`text` then misses the match
// and the official copy is appended as a duplicate turn on every reopen — so we
// fall back to the record's assistant text.
function comparableMessageText(message = {}) {
  return normalizedContent(
    message?.content || message?.text || message?.record?.assistantText || "",
  );
}

function contentOverlaps(a = "", b = "") {
  const left = normalizedContent(a);
  const right = normalizedContent(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function recordRichness(record = null) {
  if (!record || typeof record !== "object") return 0;
  let score = 1;
  score += countArray(record.resultBlocks) * 5;
  score += countArray(record.artifacts) * 4;
  score += countArray(record.contentBlocks) * 4;
  score += countArray(record.timeline) * 2;
  score += countArray(record.processEvents) * 2;
  score += countArray(record.notices);
  score += countArray(record.tools);
  if (record.assistantText) score += 1;
  if (record.engineMessageId) score += 1;
  if (record.persistenceCompact) score -= 4;
  return score;
}

function mergeConversationRecord(existingRecord = null, incomingRecord = null) {
  if (!existingRecord) return incomingRecord || null;
  if (!incomingRecord) return existingRecord;
  return recordRichness(incomingRecord) >= recordRichness(existingRecord)
    ? incomingRecord
    : existingRecord;
}

function findEquivalentMessageIndex(messages, message) {
  const key = stableConversationMessageKey(message);
  if (key) {
    const index = messages.findIndex((item) => stableConversationMessageKey(item) === key);
    if (index >= 0) return index;
  }

  const text = comparableMessageText(message);
  if (!message?.role || !text) return -1;
  const messageTime = timestampMs(message.timestamp);
  return messages.findIndex((item) => {
    if (item?.role !== message.role) return false;
    const itemText = comparableMessageText(item);
    if (itemText !== text) {
      if (message.role !== "assistant" || !contentOverlaps(itemText, text)) return false;
    }
    const itemTime = timestampMs(item.timestamp);
    if (!Number.isFinite(messageTime) || !Number.isFinite(itemTime)) return true;
    return Math.abs(itemTime - messageTime) <= 10 * 60 * 1000;
  });
}

function mergeConversationMessage(existing = {}, incoming = {}) {
  const record = mergeConversationRecord(existing.record, incoming.record);
  return {
    ...existing,
    ...incoming,
    files: incoming.files || existing.files,
    turnId: incoming.turnId || existing.turnId,
    record,
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
