/** Merge by durable command identity; older pages cannot undo a new revision. */

function messageFingerprint(message) {
  const text = String(message.bodyText || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

function messageKeys(message) {
  const keys = [];
  const seq = Number(message.seq);
  const hasSeq = Number.isSafeInteger(seq) && seq > 0;
  const createdAt = Number(message.createdAt || message.clientCreatedAt || 0);
  const createdBucket = Number.isSafeInteger(createdAt) ? Math.max(0, Math.floor(createdAt / 1000)) : 0;
  const conversationId = String(message.conversationId || "");
  const sender = String(message.senderUserId || "");
  const replyTo = String(message.replyToMessageId || "");
  const mentionKey = Array.isArray(message.mentionUserIds) ? message.mentionUserIds.slice(0, 8).join(",") : "";
  const attachmentKey = Array.isArray(message.attachmentIds) ? message.attachmentIds.length : 0;
  const revision = Number(message.revision || 1);
  const id = String(message.id || "");
  const cc = String(message.clientCommandId || "");
  if (hasSeq) keys.push(`seq:${seq}`);
  if (id) keys.push(`id:${id}`);
  if (cc) keys.push(`cc:${cc}`);
  if (!keys.length) keys.push(`meta:${conversationId}:${sender}:${replyTo}:${mentionKey}:${createdBucket}:r${revision}:a${attachmentKey}:${messageFingerprint(message)}`);
  return keys;
}

function resolveIdentity(messages = [], incoming) {
  const incomingKeys = new Set(messageKeys(incoming));
  if (!incomingKeys.size) return null;
  for (const message of messages) for (const key of messageKeys(message)) if (incomingKeys.has(key)) return message;
  return null;
}

/* Durable fallback for optimistic bubbles that race the server ack without
   a shared command id: the server-confirmed row and the local draft are the
   same user action only when the sender, conversation, exact text, revision
   and a short time window agree AND exactly one side is confirmed (has seq).
   Two confirmed messages with equal text are never merged (distinct commands). */
const OPTIMISTIC_ACK_WINDOW_MS = 60 * 1000;

function sameDurableIdentity(a, b) {
  const aSeq = Number(a.seq);
  const bSeq = Number(b.seq);
  const aHasSeq = Number.isSafeInteger(aSeq) && aSeq > 0;
  const bHasSeq = Number.isSafeInteger(bSeq) && bSeq > 0;
  if (aHasSeq === bHasSeq) return false;
  if (String(a.conversationId || "") !== String(b.conversationId || "")) return false;
  if (String(a.senderUserId || "") !== String(b.senderUserId || "")) return false;
  if (String(a.bodyText || "") !== String(b.bodyText || "")) return false;
  if (Number(a.revision || 1) !== Number(b.revision || 1)) return false;
  const aAt = Number(a.createdAt || a.clientCreatedAt || 0);
  const bAt = Number(b.createdAt || b.clientCreatedAt || 0);
  if (!(aAt > 0) || !(bAt > 0)) return false;
  return Math.abs(aAt - bAt) <= OPTIMISTIC_ACK_WINDOW_MS;
}

function resolveIdentityWithFallback(messages = [], incoming) {
  const direct = resolveIdentity(messages, incoming);
  if (direct) return direct;
  for (const message of messages) if (sameDurableIdentity(message, incoming)) return message;
  return null;
}

function isMoreAuthoritative(candidate, prior) {
  if (!prior) return true;
  const candidateSeq = Number(candidate.seq);
  const priorSeq = Number(prior.seq);
  const candidateHasSeq = Number.isSafeInteger(candidateSeq) && candidateSeq > 0;
  const priorHasSeq = Number.isSafeInteger(priorSeq) && priorSeq > 0;
  if (candidateHasSeq !== priorHasSeq) return candidateHasSeq;
  if (candidateHasSeq && priorHasSeq) {
    if (candidateSeq !== priorSeq) return candidateSeq > priorSeq;
    const candidateRevision = Number(candidate.revision || 1);
    const priorRevision = Number(prior.revision || 1);
    return candidateRevision >= priorRevision;
  }
  const candidateRevision = Number(candidate.revision || 1);
  const priorRevision = Number(prior.revision || 1);
  return candidateRevision >= priorRevision;
}

export function mergeCollaborationHistory(existing = [], incoming = []) {
  const retained = [];
  for (const message of [...existing, ...incoming]) {
    const prior = resolveIdentityWithFallback(retained, message);
    const hasMatch = Boolean(prior);
    if (!hasMatch) {
      retained.push(message);
      continue;
    }
    const shouldReplace = isMoreAuthoritative(message, prior);
    if (!shouldReplace) continue;
    Object.assign(prior, message);
  }
  return retained;
}

export function applyCollaborationHistoryPage(previous = {}, page = {}, { latest = false } = {}) {
  const incoming = page.messages || [], existing = previous.messages || [];
  const incomingIds = new Set(incoming.filter((row) => row.seq != null).map((row) => row.id));
  const overlap = existing.some((row) => row.seq != null && incomingIds.has(row.id));
  const completeLatest = latest && page.offline === false && page.hasMore === false;
  // Cache exhaustion does not prove server exhaustion. A disjoint newest
  // window also leaves a gap, which must be filled before the oldest cursor.
  const resetCoverage = !latest || !overlap || (previous.offline && !page.offline) || previous.nextBeforeSeq == null || completeLatest;
  const retained = latest ? existing.filter((row) => row.seq != null && (!completeLatest || incomingIds.has(row.id))) : existing;
  return {
    messages: mergeCollaborationHistory(retained, incoming),
    nextBeforeSeq: resetCoverage ? (page.nextBeforeSeq ?? null) : previous.nextBeforeSeq,
    hasMore: resetCoverage ? page.hasMore === true : previous.hasMore === true,
    offline: page.offline === true,
  };
}
