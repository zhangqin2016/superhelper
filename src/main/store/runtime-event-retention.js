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
function pruneOrphanRuntimeEvents(db, { limit = 50_000, maxSessions = 4 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50_000, 500_000));
  const sessionCap = Math.max(1, Math.min(Number(maxSessions) || 4, 100));
  // Delete BY SESSION, one statement each, not row by row.
  //
  // The first version issued one DELETE per row inside a transaction. node:sqlite
  // is synchronous and this runs on the main process, so 20,000 statements per
  // round x 50 rounds blocked the event loop and froze the UI for the first two
  // minutes after startup — measured on a real 12 GB install, exactly 1,000,000
  // rows removed before MAX_ROUNDS stopped it. Orphans always belong to whole
  // deleted conversations, so a handful of statements does the same work: 75
  // sessions instead of 1.5 million rows.
  const sessions = db.all(
    `SELECT e.session_id AS session_id, COUNT(*) AS n
       FROM runtime_events e
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = e.session_id)
      GROUP BY e.session_id
      ORDER BY n ASC
      LIMIT ?`,
    sessionCap,
  );
  if (!sessions.length) return 0;

  let removed = 0;
  for (const row of sessions) {
    // Stop once this round has done enough, so a session with millions of
    // events cannot turn one round into a long stall.
    if (removed >= lim) break;
    const result = db.run(`DELETE FROM runtime_events WHERE session_id = ?`, row.session_id);
    removed += Number(result?.changes ?? row.n) || 0;
  }
  return removed;
}

/**
 * Event types that exist only to paint a turn while it runs.
 *
 * `assistant.delta` and `assistant.thinking.delta` are already folded into
 * turn_projection by _projectRuntimeEvent at INSERT time, so the text survives
 * without them. `task.step.progress`, `process.event` and `subagent.event` are
 * live progress with no reader at all once the turn is over.
 *
 * This is an ALLOWLIST of what may be deleted, never "everything except". The
 * history query (getProjectedConversation) LEFT JOINs runtime_events for
 * turn.completed / turn.failed / turn.interrupted / turn.stalled /
 * turn.dispatch_outcome_unknown / turn.dispatch_blocked and rebuilds the
 * assistant text from that payload — 806 such rows on a real install, and an
 * exclusion list would eventually eat them.
 */
const EPHEMERAL_EVENT_TYPES = Object.freeze([
  "assistant.delta",
  "assistant.thinking.delta",
  "task.step.progress",
  "process.event",
  "subagent.event",
]);

/**
 * Drop a finished turn's live-painting events.
 *
 * Measured on a real install: 98.2% of the events belonging to sessions that
 * still exist. Deleting them as each turn ends is what stops the database
 * growing at all — one turn's worth at a time, on a path that is already
 * writing, instead of a multi-million-row backlog that needs a full scan to
 * find and a VACUUM to reclaim.
 *
 * A client long-polling the control server for this turn may miss deltas it had
 * not fetched yet; the turn is over and the terminal event, which carries the
 * final assistant text, is preserved. Kill switch: LILY_PRUNE_TURN_EVENTS=0.
 *
 * @returns {number} rows deleted
 */
function pruneFinishedTurnEvents(db, sessionId, turnId) {
  if (process.env.LILY_PRUNE_TURN_EVENTS === "0") return 0;
  const sid = String(sessionId || "");
  const tid = String(turnId || "");
  if (!sid || !tid) return 0;
  const placeholders = EPHEMERAL_EVENT_TYPES.map(() => "?").join(",");
  const result = db.run(
    `DELETE FROM runtime_events
      WHERE session_id = ? AND turn_id = ? AND type IN (${placeholders})`,
    sid,
    tid,
    ...EPHEMERAL_EVENT_TYPES,
  );
  return Number(result?.changes || 0);
}

const HISTORY_CURSOR_KEY = "runtimeEventHistoryPrune:v1";
const HISTORY_DONE = "done";
const DEFAULT_SEQ_WINDOW = 20_000;

function readMeta(db, key) {
  try {
    const row = db.get(`SELECT value FROM schema_meta WHERE key = ?`, key);
    return row ? String(row.value) : null;
  } catch {
    return null;
  }
}

function writeMeta(db, key, value) {
  db.run(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    String(value),
  );
}

/**
 * Drain the ephemeral events a pre-retention install already accumulated,
 * in chunks small enough that nobody notices.
 *
 * The obvious query — DELETE ... WHERE type IN (...) — is a full table SCAN,
 * because nothing indexes `type`. Measured on a real 12 GB install that is a
 * single 19.8-second block, and node:sqlite is synchronous on the main
 * process, so it can never go on a startup or idle path.
 *
 * Bounding the work by the PRIMARY KEY instead turns it into an index range
 * scan: `session_id = ? AND seq BETWEEN ? AND ?` measured 30 ms for a 20,000-
 * seq window that matched 19,726 rows. The whole 2.9 M rows come to roughly
 * 150 such windows — about 4.5 seconds of work, delivered 30 ms at a time.
 *
 * A cursor in schema_meta records how far it got, so it resumes across
 * restarts and, once finished, never looks again. This also supersedes the
 * orphan scan: a deleted conversation's rows are the same ephemeral types, so
 * they are drained here without any NOT EXISTS discovery.
 *
 * Kill switch: LILY_PRUNE_EVENT_HISTORY=0.
 *
 * @returns {{ done: boolean, removed: number, chunks: number }}
 */
function pruneHistoricalEphemeralEvents(db, { maxChunks = 4, seqWindow = DEFAULT_SEQ_WINDOW } = {}) {
  if (process.env.LILY_PRUNE_EVENT_HISTORY === "0") return { done: true, removed: 0, chunks: 0 };
  const cursorRaw = readMeta(db, HISTORY_CURSOR_KEY);
  if (cursorRaw === HISTORY_DONE) return { done: true, removed: 0, chunks: 0 };

  const placeholders = EPHEMERAL_EVENT_TYPES.map(() => "?").join(",");
  const chunkLimit = Math.max(1, Math.min(Number(maxChunks) || 4, 64));
  const windowSize = Math.max(1_000, Math.min(Number(seqWindow) || DEFAULT_SEQ_WINDOW, 200_000));

  let cursor = null;
  try {
    cursor = cursorRaw ? JSON.parse(cursorRaw) : null;
  } catch {
    cursor = null;
  }
  let sessionId = cursor && typeof cursor.sessionId === "string" ? cursor.sessionId : "";
  let nextSeq = Number.isFinite(cursor?.nextSeq) ? Number(cursor.nextSeq) : 0;

  let removed = 0;
  let chunks = 0;
  while (chunks < chunkLimit) {
    // Sessions are walked in id order so the cursor is a single scalar. The
    // list comes from the primary key's leading column, so this is an index
    // scan rather than a table scan.
    if (!sessionId) {
      const next = db.get(
        `SELECT session_id FROM runtime_events WHERE session_id > ? ORDER BY session_id LIMIT 1`,
        String(cursor?.lastSession || ""),
      );
      if (!next) {
        writeMeta(db, HISTORY_CURSOR_KEY, HISTORY_DONE);
        return { done: true, removed, chunks };
      }
      sessionId = String(next.session_id);
      nextSeq = 0;
    }

    const maxSeqRow = db.get(`SELECT MAX(seq) AS hi FROM runtime_events WHERE session_id = ?`, sessionId);
    const hi = Number(maxSeqRow?.hi || 0);
    if (!hi || nextSeq > hi) {
      // Finished this session; remember it so the next lookup steps past it.
      writeMeta(db, HISTORY_CURSOR_KEY, JSON.stringify({ lastSession: sessionId, sessionId: "", nextSeq: 0 }));
      cursor = { lastSession: sessionId };
      sessionId = "";
      continue;
    }

    const upper = nextSeq + windowSize;
    const result = db.run(
      `DELETE FROM runtime_events
        WHERE session_id = ? AND seq >= ? AND seq < ? AND type IN (${placeholders})`,
      sessionId,
      nextSeq,
      upper,
      ...EPHEMERAL_EVENT_TYPES,
    );
    removed += Number(result?.changes || 0);
    nextSeq = upper;
    chunks += 1;
    writeMeta(db, HISTORY_CURSOR_KEY, JSON.stringify({ lastSession: cursor?.lastSession || "", sessionId, nextSeq }));
  }
  return { done: false, removed, chunks };
}

function countOrphanRuntimeEvents(db) {
  return Number(db.get(
    `SELECT COUNT(*) AS n FROM runtime_events e
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = e.session_id)`,
  )?.n || 0);
}

module.exports = {
  EPHEMERAL_EVENT_TYPES,
  HISTORY_CURSOR_KEY,
  pruneHistoricalEphemeralEvents,
  pruneFinishedTurnEvents,
  compactRuntimeEventPayloads,
  pruneOrphanRuntimeEvents,
  countOrphanRuntimeEvents,
};
