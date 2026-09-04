"use strict";

/**
 * Runtime-event retention: keeping the message database from growing without
 * bound.
 *
 * Runtime events are the per-token stream Lily persists so a turn can be
 * replayed or resumed. They were INSERTed and UPDATEd but never DELETEd
 * anywhere in the repo, and clearing a conversation removed only its messages —
 * so every deleted conversation left its whole event stream behind forever, on
 * the database every turn writes to.
 *
 * Measured on a real install 2026-09-04: 12 GB holding 1,156 messages and
 * 3,917,891 events across 155 sessions, while only 29 sessions still had
 * messages. 2,542,720 of them (64.9%) were orphans from 135 deleted
 * conversations, almost all per-token telemetry with no consumer once the turn
 * ended (process.event 1,457,033, task.step.progress 1,158,734,
 * assistant.thinking.delta 936,587).
 *
 * Extracted from message-store.js, which was at its line ratchet. Payload
 * compaction and row retention are one concern: bounding what the event log
 * costs.
 */

const { compactRuntimeEventForPersistence } = require("./runtime-event-persistence");

// Same shape as message-store's local helpers; kept here so this module stands
// on its own rather than reaching back into the file it was extracted from.
function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}

function compactRuntimeEventPayloads(db, { limit = 200, minBytes = 20_000 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const threshold = Math.max(1_000, Number(minBytes) || 20_000);
  const rows = db.all(
    `SELECT session_id, seq, id, turn_id, type, source, ts, payload_json
     FROM runtime_events
     WHERE length(payload_json) > ?
       AND payload_json NOT LIKE '%"persistenceCompact":true%'
       AND type IN (
         'process.event',
         'subagent.event',
         'tool.started',
         'tool.input.done',
         'tool.done',
         'user.committed',
         'assistant.final',
         'turn.completed',
         'turn.failed',
         'turn.interrupted',
         'turn.stalled'
       )
     ORDER BY length(payload_json) DESC
     LIMIT ?`,
    threshold,
    lim,
  );
  if (!rows.length) return { scanned: 0, compacted: 0, beforeBytes: 0, afterBytes: 0 };
  return db.transaction(() => {
    let compacted = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    for (const row of rows) {
      const payload = parseJson(row.payload_json, null);
      if (!payload || typeof payload !== "object") continue;
      const before = String(row.payload_json || "");
      const event = {
        id: row.id,
        type: row.type,
        sessionId: row.session_id,
        turnId: row.turn_id || null,
        seq: row.seq,
        ts: row.ts,
        source: row.source,
        payload,
      };
      const persistedEvent = compactRuntimeEventForPersistence(event);
      const nextPayload = persistedEvent.payload && typeof persistedEvent.payload === "object"
        ? persistedEvent.payload
        : {};
      const after = stringifyJson(nextPayload, {});
      if (after.length >= before.length) continue;
      db.run(
        `UPDATE runtime_events
         SET payload_json = ?, original_type = ?, original_event_id = ?
         WHERE session_id = ? AND seq = ?`,
        after,
        nextPayload.rawType || nextPayload.event?.type || null,
        nextPayload.event?.id || null,
        row.session_id,
        row.seq,
      );
      compacted += 1;
      beforeBytes += before.length;
      afterBytes += after.length;
    }
    return { scanned: rows.length, compacted, beforeBytes, afterBytes };
  })();
}

/**
 * Drop runtime events whose session has no messages left.
 *
 * Bounded per call so a huge backlog is worked off across startups instead of
 * blocking one. Deleting events for a session that no longer exists cannot
 * affect any live session — the only reader, getRuntimeEvents, is always
 * scoped to a session id.
 *
 * @returns {number} rows deleted
 */
function pruneOrphanRuntimeEvents(db, { limit = 50_000 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50_000, 500_000));
  return db.transaction(() => {
    const rows = db.all(
      `SELECT session_id, seq FROM runtime_events e
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = e.session_id)
        LIMIT ?`,
      lim,
    );
    for (const row of rows) {
      db.run(`DELETE FROM runtime_events WHERE session_id = ? AND seq = ?`, row.session_id, row.seq);
    }
    return rows.length;
  })();
}

/** How many runtime events belong to sessions that no longer have messages. */
function countOrphanRuntimeEvents(db, ) {
  return Number(db.get(
    `SELECT COUNT(*) AS n FROM runtime_events e
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = e.session_id)`,
  )?.n || 0);
}

module.exports = {
  compactRuntimeEventPayloads,
  pruneOrphanRuntimeEvents,
  countOrphanRuntimeEvents,
};
