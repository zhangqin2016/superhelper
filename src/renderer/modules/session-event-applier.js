/**
 * Applies ordered session-events batches to the chat DOM (transcript layer).
 */

/**
 * @param {{
 *   materializeTurnEnded: (sessionId: string, event: object) => void,
 *   appendUserCommitted: (sessionId: string, event: object) => void,
 * }} deps
 */
export function createSessionEventApplier(deps) {
  /** @type {Map<string, number>} */
  const lastSeq = new Map();

  return function applySessionEventBatch(payload) {
    const sessionId = payload?.sessionId;
    const events = payload?.events;
    const seq = payload?.seq;
    if (!sessionId || !Array.isArray(events) || !events.length) return;

    if (typeof seq === "number") {
      const prev = lastSeq.get(sessionId) || 0;
      if (seq <= prev) return;
      lastSeq.set(sessionId, seq);
    }

    for (const event of events) {
      if (event.type === "turn-ended") {
        deps.materializeTurnEnded(sessionId, event);
      } else if (event.type === "user-committed") {
        deps.appendUserCommitted(sessionId, event);
      }
    }
  };
}
