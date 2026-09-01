/** Merge by durable command identity; older pages cannot undo a new revision. */
export function mergeCollaborationHistory(existing = [], incoming = []) {
  const rows = new Map();
  for (const message of [...existing, ...incoming]) {
    const key = String(message.clientCommandId || message.id);
    const prior = rows.get(key);
    const revision = Number(message.revision || 1), priorRevision = Number(prior?.revision || 1);
    const authoritative = message.seq != null, priorAuthoritative = prior?.seq != null;
    if (!prior || (authoritative !== priorAuthoritative ? authoritative : revision >= priorRevision)) rows.set(key, message);
  }
  return [...rows.values()];
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
