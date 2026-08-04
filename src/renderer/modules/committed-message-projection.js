function messageQuality(message = {}) {
  let score = 0;
  if (message.id) score += 1;
  if (message.turnId) score += 2;
  if (message.record) score += 4;
  if (message.meta) score += 2;
  if (message.files?.length) score += 1;
  return score;
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

function mergeCommittedRecord(existingRecord = null, incomingRecord = null) {
  if (!existingRecord) return incomingRecord || null;
  if (!incomingRecord) return existingRecord;
  return recordRichness(incomingRecord) >= recordRichness(existingRecord)
    ? incomingRecord
    : existingRecord;
}

function mergeCommittedMessage(existing = {}, incoming = {}) {
  const preferIncoming = messageQuality(incoming) >= messageQuality(existing);
  const replacesRecovery = Boolean(
    (
      existing.meta?.outcomeUnknown ||
      existing.meta?.dispatchBlocked ||
      existing.record?.meta?.outcomeUnknown ||
      existing.record?.meta?.dispatchBlocked
    ) &&
    !(
      incoming.meta?.outcomeUnknown ||
      incoming.meta?.dispatchBlocked ||
      incoming.record?.meta?.outcomeUnknown ||
      incoming.record?.meta?.dispatchBlocked
    ),
  );
  const base = preferIncoming ? { ...existing, ...incoming } : { ...incoming, ...existing };
  const record = replacesRecovery
    ? (incoming.record || null)
    : mergeCommittedRecord(existing.record, incoming.record);
  return {
    ...base,
    id: incoming.id || existing.id,
    content: incoming.content || existing.content || "",
    files: incoming.files || existing.files,
    turnId: incoming.turnId || existing.turnId,
    record,
    failed: replacesRecovery ? Boolean(incoming.failed) : Boolean(incoming.failed || existing.failed),
    meta: {
      ...(replacesRecovery ? {} : (existing.meta || {})),
      ...(incoming.meta || {}),
    },
  };
}

export function createCommittedMessageProjection(equivalentMessageIndex) {
  function dedupeCommittedMessages(messages = []) {
    const out = [];
    for (const message of messages || []) {
      if (!message?.role) continue;
      const index = equivalentMessageIndex(out, message);
      if (index < 0) {
        out.push(message);
        continue;
      }
      out[index] = mergeCommittedMessage(out[index], message);
    }
    return out;
  }

  function mergeIncomingCommittedMessages(existingMessages = [], incomingMessages = []) {
    return (incomingMessages || []).map((message) => {
      if (!message?.role) return message;
      const index = equivalentMessageIndex(existingMessages, message);
      return index >= 0 ? mergeCommittedMessage(existingMessages[index], message) : message;
    });
  }

  function upsertCommittedMessage(runtime, message) {
    const index = equivalentMessageIndex(runtime.committedMessages, message);
    if (index < 0) {
      runtime.committedMessages.push(message);
      return;
    }
    runtime.committedMessages[index] = mergeCommittedMessage(runtime.committedMessages[index], message);
  }

  return {
    dedupeCommittedMessages,
    mergeIncomingCommittedMessages,
    upsertCommittedMessage,
  };
}
