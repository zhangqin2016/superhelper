"use strict";

/**
 * MessageStore — Lily metadata + legacy/fallback transcript store.
 *
 * Replaces the per-session JSON files (which were parsed in full on every
 * session open — the cause of multi-second freezes on large sessions). Reads
 * are bounded keyset queries over an indexed table, so opening a session is
 * O(page) regardless of total history. Writes are single-row inserts in a
 * transaction — O(1), no file rewrite (kills the old O(n²) save).
 *
 * OpenCode owns the canonical engine transcript for OpenCode-backed sessions.
 * Lily keeps this store for old installs, offline fallback, and product metadata
 * (artifacts, diffs, result blocks, usage summaries) keyed by engineMessageId.
 * Each stored row keeps cheap "hot" columns (for listing / search / analytics)
 * plus `envelope_blob` = gzip(JSON(message)) with oversized data: URLs swapped
 * for blob refs. A page read decompresses only the rows it returns.
 */

const crypto = require("node:crypto");
const { openMessageDatabase } = require("./sqlite-db");
const { BlobStore } = require("./blob-store");
const { MIGRATIONS } = require("./schema");
const { externalize, collectRefs } = require("./record-blobs");
const { compactRuntimeEventForPersistence } = require("./runtime-event-persistence");
const runtimeEventRetention = require("./runtime-event-retention");
const { emptyProjection, projectedRecordParts, projectionUserMessages, reduceProjection } = require("./turn-projection-reducer");

// The types getProjectedConversation LEFT JOINs to rebuild a turn's assistant
// text. Reaching one of these means the turn is over.
const TERMINAL_TURN_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
  "turn.dispatch_outcome_unknown",
  "turn.dispatch_blocked",
]);
const { listSessionSummaries } = require("./message-store-session-inventory");
const { pack, unpack } = require("./message-envelope");
const { DISPATCH_OUTCOME_UNKNOWN_ASSISTANT } = require("../turn-recovery-projection");
const PREVIEW_MAX = 500;

function fingerprintMessage(message) {
  const hash = crypto.createHash("sha256");
  const stable = {
    role: message?.role || "assistant",
    content: message?.content || "",
    files: message?.files || null,
    turnId: message?.turnId || message?.record?.turnId || null,
    timestamp: message?.timestamp || null,
    failed: Boolean(message?.failed),
    terminal: message?.record?.terminal || message?.meta?.terminal || null,
  };
  hash.update(JSON.stringify(stable));
  return hash.digest("hex");
}

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

function previewOf(message) {
  const text = message.content || message.record?.assistantText || "";
  return String(text).slice(0, PREVIEW_MAX);
}

function hotColumns(message) {
  const rec = message.record || null;
  const ts = Date.parse(message.timestamp || "");
  return {
    id: message.id || `msg_${crypto.randomUUID()}`,
    role: message.role || "assistant",
    turn_id: message.turnId || rec?.turnId || null,
    created_at: Number.isFinite(ts) ? ts : Date.now(),
    preview: previewOf(message),
    failed: message.failed ? 1 : 0,
    terminal: rec?.terminal || message.meta?.terminal || null,
    cost_usd: typeof rec?.totalCostUsd === "number" ? rec.totalCostUsd : null,
    duration_ms: Number.isInteger(rec?.durationMs) ? rec.durationMs : null,
  };
}

class MessageStore {
  /**
   * @param {string} dbPath    absolute path to messages.db (":memory:" in tests)
   * @param {string} blobDir   directory for the content-addressed blob tree
   */
  constructor(dbPath, blobDir) {
    this.db = openMessageDatabase(dbPath);
    this.db.migrate(MIGRATIONS);
    this.db.run(
      `UPDATE turn_inputs
       SET status = 'outcome_unknown'
       WHERE status = 'dispatching' AND migration_status = 'owned'`,
    );
    this.blobs = new BlobStore(blobDir);
  }

  // --- internal: link a message's blobs and bump refcounts (in a tx) ---
  _linkBlob(messageId, ref) {
    this.db.run(
      `INSERT OR IGNORE INTO blobs (hash, bytes, mime, refcount, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      ref.hash,
      ref.bytes,
      ref.mime || null,
      Date.now(),
    );
    const linked = this.db.run(
      `INSERT OR IGNORE INTO message_blobs (message_id, hash) VALUES (?, ?)`,
      messageId,
      ref.hash,
    );
    if (linked.changes > 0) {
      this.db.run(`UPDATE blobs SET refcount = refcount + 1 WHERE hash = ?`, ref.hash);
    }
  }

  _unlinkMessageBlobs(messageId) {
    const rows = this.db.all(`SELECT hash FROM message_blobs WHERE message_id = ?`, messageId);
    if (rows.length === 0) return;
    this.db.run(`DELETE FROM message_blobs WHERE message_id = ?`, messageId);
    for (const { hash } of rows) {
      this.db.run(`UPDATE blobs SET refcount = refcount - 1 WHERE hash = ?`, hash);
      const left = this.db.get(`SELECT refcount FROM blobs WHERE hash = ?`, hash);
      if (left && left.refcount <= 0) {
        this.db.run(`DELETE FROM blobs WHERE hash = ?`, hash);
        this.blobs.remove(hash);
      }
    }
  }

  _nextSeq(sessionId) {
    const row = this.db.get(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?`,
      sessionId,
    );
    return row.next;
  }

  _insert(sessionId, message) {
    const hot = hotColumns(message);
    const withId = message.id === hot.id ? message : { ...message, id: hot.id };
    const { envelope, refs } = externalize(withId, this.blobs);
    const seq = this._nextSeq(sessionId);
    this.db.run(
      `INSERT INTO messages
         (session_id, seq, id, role, turn_id, created_at, preview, failed,
          terminal, cost_usd, duration_ms, envelope_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      seq,
      hot.id,
      hot.role,
      hot.turn_id,
      hot.created_at,
      hot.preview,
      hot.failed,
      hot.terminal,
      hot.cost_usd,
      hot.duration_ms,
      pack(envelope),
    );
    for (const ref of refs) this._linkBlob(hot.id, ref);
    return envelope;
  }

  /** Append one message; returns the stored envelope (with assigned id). */
  append(sessionId, message) {
    return this.db.transaction(() => this._insert(sessionId, message))();
  }

  appendRuntimeEvents(sessionId, events) {
    const sid = String(sessionId || "");
    const list = Array.isArray(events) ? events : [];
    if (!sid || list.length === 0) return [];
    return this.db.transaction(() => {
      const stored = [];
      const pending = new Map();
      for (const event of list) {
        if (!event?.id || !event?.type) continue;
        const persistedEvent = compactRuntimeEventForPersistence(event);
        const persistedPayload =
          persistedEvent.payload && typeof persistedEvent.payload === "object"
            ? persistedEvent.payload
            : {};
        try {
          const inserted = this.db.run(
            `INSERT OR IGNORE INTO runtime_events
               (session_id, seq, id, turn_id, type, source, ts, payload_json,
                original_type, original_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sid,
            Number.isInteger(event.seq) ? event.seq : 0,
            event.id,
            event.turnId || null,
            event.type,
            event.source || "runtime",
            Number.isFinite(event.ts) ? event.ts : Date.now(),
            stringifyJson(persistedPayload, {}),
            persistedPayload.rawType || persistedPayload.event?.type || null,
            persistedPayload.event?.id || null,
          );
          if (inserted.changes > 0) {
            this._projectRuntimeEvent(sid, event, pending);
            stored.push(persistedEvent);
            // A turn that just reached a terminal state no longer needs the
            // events that only painted it while it ran. Deleting them here,
            // one turn at a time on a path already inside a transaction, is
            // what keeps this table from growing without bound — the
            // alternative is the multi-million-row backlog that needed a full
            // scan to find and a VACUUM to reclaim. The terminal event itself
            // is NOT in the ephemeral allowlist: the history query rebuilds
            // assistant text from its payload.
            if (TERMINAL_TURN_EVENT_TYPES.has(event.type) && event.turnId) {
              try {
                runtimeEventRetention.pruneFinishedTurnEvents(this.db, sid, event.turnId);
              } catch {
                // Retention is maintenance; never fail a turn over it.
              }
            }
          }
        } catch {
          // A malformed runtime diagnostic should not break the user turn.
        }
      }
      for (const projection of pending.values()) this._writeTurnProjection(projection);
      return stored;
    })();
  }

  getRuntimeEvents(sessionId, { afterSeq = 0, limit = 500 } = {}) {
    const rows = this.db.all(
      `SELECT * FROM runtime_events
       WHERE session_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
      String(sessionId || ""),
      Number.isInteger(afterSeq) ? afterSeq : 0,
      Math.max(1, Math.min(Number(limit) || 500, 2000)),
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      sessionId: row.session_id,
      turnId: row.turn_id || null,
      seq: row.seq,
      ts: row.ts,
      source: row.source,
      payload: parseJson(row.payload_json, {}),
      originalType: row.original_type || null,
      originalEventId: row.original_event_id || null,
    }));
  }

  getLastRuntimeEventSeq(sessionId) {
    return Number(this.db.get(
      "SELECT MAX(seq) AS seq FROM runtime_events WHERE session_id=?",
      String(sessionId || ""),
    )?.seq || 0);
  }

  getTurnProjection(sessionId, turnId) {
    const row = this.db.get(
      `SELECT * FROM turn_projection WHERE session_id = ? AND turn_id = ?`,
      String(sessionId || ""),
      String(turnId || ""),
    );
    return row ? this._hydrateTurnProjection(row) : null;
  }

  /** @see turn-failure-history — what keeps failing on this install. */
  recentFailureCodes(options = {}) {
    return require("./turn-failure-history").recentFailureCodes(this.db, options);
  }

  getTurnProjections(sessionId, { limit = 100 } = {}) {
    return this.db.all(
      `SELECT * FROM turn_projection
       WHERE session_id = ?
       ORDER BY COALESCE(started_at, updated_at) ASC
       LIMIT ?`,
      String(sessionId || ""),
      Math.max(1, Math.min(Number(limit) || 100, 1000)),
    ).map((row) => this._hydrateTurnProjection(row));
  }

  getProjectedConversation(sessionId, { limit = 100, includeOpen = true } = {}) {
    // The NEWEST `limit` turns, returned oldest-first. Ordering ascending before
    // the LIMIT returned a long session's FIRST turns instead, so past `limit`
    // turns the latest ones silently fell out of every reader of this.
    const rows = this.db.all(
      `SELECT * FROM (
         SELECT p.*,
                e.payload_json AS terminal_payload_json,
                e.ts AS terminal_event_ts
         FROM turn_projection p
         LEFT JOIN runtime_events e
           ON e.session_id = p.session_id
          AND e.turn_id = p.turn_id
          AND e.type IN ('turn.completed', 'turn.failed', 'turn.interrupted', 'turn.stalled', 'turn.dispatch_outcome_unknown', 'turn.dispatch_blocked')
         WHERE p.session_id = ?
           AND (? OR p.terminal_type IS NOT NULL)
         ORDER BY COALESCE(p.started_at, p.updated_at) DESC
         LIMIT ?
       ) ORDER BY COALESCE(started_at, updated_at) ASC`,
      String(sessionId || ""),
      includeOpen ? 1 : 0,
      Math.max(1, Math.min(Number(limit) || 100, 1000)),
    );
    const conversation = [];
    for (const row of rows) {
      const projection = this._hydrateTurnProjection(row);
      const terminalPayload = parseJson(row.terminal_payload_json, {});
      const startedAt = projection.startedAt || projection.updatedAt || Date.now();
      const terminalAt = projection.terminalAt || row.terminal_event_ts || projection.updatedAt || startedAt;
      const scheduledDraft =
        terminalPayload?.scheduledDraft ||
        terminalPayload?.record?.meta?.scheduledDraft ||
        projection.payload?.scheduledDraft ||
        null;
      const userMessages = projectionUserMessages(projection);
      for (const [userIndex, userMessage] of userMessages.entries()) {
        const userTs = Number.isFinite(userMessage.ts)
          ? userMessage.ts
          : (userIndex === 0 ? startedAt : startedAt + userIndex);
        conversation.push({
          id: userMessage.steer
            ? `projection:${projection.turnId}:user:steer:${userMessage.steerSeq ?? userIndex}`
            : `projection:${projection.turnId}:user`,
          role: "user",
          content: userMessage.text,
          files: userMessage.files || undefined,
          turnId: projection.turnId,
          timestamp: new Date(userTs).toISOString(),
          meta: {
            canonicalSource: "lily-projection",
            projected: true,
            ...(userMessage.steer ? { steer: true, steerSeq: userMessage.steerSeq } : {}),
          },
        });
      }
      const outcomeUnknown = projection.status === "outcome_unknown";
      const dispatchBlocked = projection.status === "dispatch_blocked";
      // No archived record: the projection IS the turn (a killed or recovered
      // run). Rebuild it the way it ran instead of an empty shell.
      const archived = terminalPayload?.record && typeof terminalPayload.record === "object";
      const parts = !archived && (outcomeUnknown || dispatchBlocked || !projection.terminalType)
        ? projectedRecordParts(projection, this._turnToolEvents(projection.sessionId, projection.turnId))
        : null;
      const assistantText = String(
        parts?.assistantText ||
        terminalPayload?.assistant ||
        terminalPayload?.record?.assistantText ||
        projection.assistantText ||
        projection.payload?.assistant ||
        (outcomeUnknown ? DISPATCH_OUTCOME_UNKNOWN_ASSISTANT : "") ||
        "",
      ).trim();
      if (!assistantText && !projection.terminalType && !outcomeUnknown && !dispatchBlocked && projection.status === "running") continue;
      const terminal = projection.terminalType || (outcomeUnknown ? "turn.dispatch_outcome_unknown" : dispatchBlocked ? "turn.dispatch_blocked" : "turn.stalled");
      const failed = terminal === "turn.failed" || outcomeUnknown || dispatchBlocked;
      const record = terminalPayload?.record && typeof terminalPayload.record === "object"
        ? terminalPayload.record
        : {
            turnId: projection.turnId,
            sessionId: projection.sessionId,
            startedAt,
            endedAt: terminalAt,
            terminal,
            user: projection.userText ? { text: projection.userText, files: null } : null,
            assistantText,
            thinkingText: projection.thinkingText || "",
            contentBlocks: [],
            protocolUnknown: [],
            tools: parts?.tools || [],
            fileChanges: [],
            artifacts: [],
            resultBlocks: [],
            timeline: parts?.timeline || [],
            activityLabel: projection.activityLabel || null,
            durationMs: Number.isFinite(startedAt) && Number.isFinite(terminalAt)
              ? Math.max(0, terminalAt - startedAt)
              : null,
            totalCostUsd: null,
            engineMessageId: null,
            processEvents: [],
            notices: parts?.notices || [],
            usage: null,
            meta: {
              terminal,
              failed,
              outcomeUnknown,
              dispatchBlocked,
              manualRecoveryRequired: outcomeUnknown && projection.payload?.manualRecoveryRequired !== false,
              recoveryId: outcomeUnknown ? projection.payload?.recoveryId || "" : "",
              retryable: dispatchBlocked,
              stalled: terminal === "turn.stalled",
              interrupted: terminal === "turn.interrupted",
              resultFromCli: false,
              toolsSummary: { count: projection.toolCount || 0 },
              canonicalSource: "lily-projection",
              projected: true,
              ...(scheduledDraft ? { scheduledDraft } : {}),
            },
          };
      conversation.push({
        id: `projection:${projection.turnId}:assistant`,
        role: "assistant",
        content: assistantText,
        turnId: projection.turnId,
        timestamp: new Date(terminalAt).toISOString(),
        record: {
          ...record,
          meta: {
            ...(record.meta || {}),
            canonicalSource: record.meta?.canonicalSource || "lily-projection",
            projected: true,
            ...(scheduledDraft && !record.meta?.scheduledDraft ? { scheduledDraft } : {}),
          },
        },
        ...(failed ? { failed: true } : {}),
        meta: {
          ...(record.meta || {}),
          terminal,
          ...(outcomeUnknown ? {
            outcomeUnknown: true,
            manualRecoveryRequired: projection.payload?.manualRecoveryRequired !== false,
            recoveryId: projection.payload?.recoveryId || "",
          } : {}),
          ...(dispatchBlocked ? {
            dispatchBlocked: true,
            manualRecoveryRequired: projection.payload?.manualRecoveryRequired !== false,
            retryable: true,
          } : {}),
          canonicalSource: "lily-projection",
          projected: true,
          ...(scheduledDraft && !record.meta?.scheduledDraft ? { scheduledDraft } : {}),
        },
      });
    }
    return conversation;
  }

  // Tool events are never pruned (they are not live-only painting), so a turn
  // with no archived record can still show every step it took.
  _turnToolEvents(sessionId, turnId) {
    return this.db.all(
      `SELECT type, payload_json FROM runtime_events
       WHERE session_id = ? AND turn_id = ? AND type IN ('tool.started', 'tool.done')
       ORDER BY seq ASC`,
      String(sessionId || ""), String(turnId || ""),
    ).map((row) => ({ type: row.type, payload: parseJson(row.payload_json, {}) }));
  }

  _hydrateTurnProjection(row) {
    return {
      sessionId: row.session_id,
      turnId: row.turn_id,
      status: row.status,
      userText: row.user_text || "",
      assistantText: row.assistant_text || "",
      thinkingText: row.thinking_text || "",
      activityLabel: row.activity_label || null,
      toolCount: row.tool_count || 0,
      noticeCount: row.notice_count || 0,
      startedAt: row.started_at || null,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at || null,
      terminalType: row.terminal_type || null,
      payload: parseJson(row.payload_json, {}),
    };
  }

  // A batch folds each turn's events in memory and writes the row once at the
  // end: every delta used to read the row, rebuild the whole accumulated text
  // and write it back — a 90 KB thinking stream rewritten per few-token chunk.
  _projectRuntimeEvent(sessionId, event, pending = null) {
    if (!event.turnId) return;
    let projection = pending?.get(event.turnId);
    if (!projection) {
      const row = this.db.get(`SELECT * FROM turn_projection WHERE session_id = ? AND turn_id = ?`, sessionId, event.turnId);
      projection = row ? this._hydrateTurnProjection(row) : emptyProjection(sessionId, event.turnId, Number.isFinite(event.ts) ? event.ts : Date.now());
    }
    reduceProjection(projection, event);
    if (pending) pending.set(event.turnId, projection);
    else this._writeTurnProjection(projection);
  }

  _writeTurnProjection(projection) {
    this.db.run(
      `INSERT INTO turn_projection
         (session_id, turn_id, status, user_text, assistant_text, thinking_text,
          activity_label, tool_count, notice_count, started_at, updated_at,
          terminal_at, terminal_type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET
         status = excluded.status,
         user_text = excluded.user_text,
         assistant_text = excluded.assistant_text,
         thinking_text = excluded.thinking_text,
         activity_label = excluded.activity_label,
         tool_count = excluded.tool_count,
         notice_count = excluded.notice_count,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         terminal_at = excluded.terminal_at,
         terminal_type = excluded.terminal_type,
         payload_json = excluded.payload_json`,
      projection.sessionId,
      projection.turnId,
      projection.status,
      projection.userText,
      projection.assistantText,
      projection.thinkingText,
      projection.activityLabel,
      projection.toolCount,
      projection.noticeCount,
      projection.startedAt,
      projection.updatedAt,
      projection.terminalAt,
      projection.terminalType,
      stringifyJson(projection.payload, {}),
    );
  }

  /** Insert many messages in order (migration / bulk import). */
  bulkInsert(sessionId, messages) {
    return this.db.transaction(() => {
      let n = 0;
      for (const message of messages) {
        this._insert(sessionId, message);
        n += 1;
      }
      return n;
    })();
  }

  /**
   * Merge messages without duplicating records already present in the session.
   *
   * Migration can be retried after crashes or partial imports, so this method is
   * deliberately multiset-based: it preserves repeated identical messages while
   * avoiding a second copy of messages that were already migrated earlier.
   */
  bulkInsertMissing(sessionId, messages) {
    return this.db.transaction(() => {
      const existingRows = this.db.all(
        `SELECT id, envelope_blob FROM messages WHERE session_id = ? ORDER BY seq ASC`,
        sessionId,
      );
      const existingById = new Set();
      const existingByFingerprint = new Map();
      for (const row of existingRows) {
        if (row.id) existingById.add(row.id);
        const envelope = unpack(row.envelope_blob);
        const fp = fingerprintMessage(envelope);
        existingByFingerprint.set(fp, (existingByFingerprint.get(fp) || 0) + 1);
      }

      const incomingByFingerprint = new Map();
      let inserted = 0;
      for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== "object") continue;
        if (message.id && existingById.has(message.id)) continue;

        const fp = fingerprintMessage(message);
        const seen = (incomingByFingerprint.get(fp) || 0) + 1;
        incomingByFingerprint.set(fp, seen);
        if ((existingByFingerprint.get(fp) || 0) >= seen) continue;

        const stored = this._insert(sessionId, message);
        if (stored?.id) existingById.add(stored.id);
        existingByFingerprint.set(fp, (existingByFingerprint.get(fp) || 0) + 1);
        inserted += 1;
      }
      return inserted;
    })();
  }


  listSessionSummaries() {
    return listSessionSummaries(this.db);
  }






  /**
   * Mutate a stored message in place. `updater(envelope)` returns the new
   * envelope (or a falsy value to abort). Hot columns + blob links are
   * recomputed so any change stays consistent. Returns the new envelope.
   */
  updateById(id, updater) {
    return this.db.transaction(() => {
      const row = this.db.get(`SELECT envelope_blob FROM messages WHERE id = ?`, id);
      if (!row) return null;
      const current = unpack(row.envelope_blob);
      const next = updater(current);
      if (!next || typeof next !== "object") return null;
      const withId = next.id === id ? next : { ...next, id };
      this._unlinkMessageBlobs(id);
      const hot = hotColumns(withId);
      const { envelope, refs } = externalize(withId, this.blobs);
      this.db.run(
        `UPDATE messages SET role = ?, turn_id = ?, preview = ?, failed = ?,
           terminal = ?, cost_usd = ?, duration_ms = ?, envelope_blob = ?
         WHERE id = ?`,
        hot.role,
        hot.turn_id,
        hot.preview,
        hot.failed,
        hot.terminal,
        hot.cost_usd,
        hot.duration_ms,
        pack(envelope),
        id,
      );
      for (const ref of refs) this._linkBlob(id, ref);
      return envelope;
    })();
  }

  /** Remove the most recent message iff its role matches; returns true if removed. */
  removeLast(sessionId, role = null) {
    return this.db.transaction(() => {
      const row = this.db.get(
        `SELECT seq, id, role FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
        sessionId,
      );
      if (!row) return false;
      if (role && row.role !== role) return false;
      this._unlinkMessageBlobs(row.id);
      this.db.run(`DELETE FROM messages WHERE session_id = ? AND seq = ?`, sessionId, row.seq);
      return true;
    })();
  }

  /** Rewind support: delete the given turn and EVERY message after it (higher
   *  seq), releasing their blobs. Returns how many messages were removed. Keeps
   *  Lily's transcript in lock-step with the engine's revert to the same turn. */
  deleteFromTurn(sessionId, turnId) {
    if (!turnId) return 0;
    return this.db.transaction(() => {
      const anchor = this.db.get(
        `SELECT MIN(seq) AS seq FROM messages WHERE session_id = ? AND turn_id = ?`,
        sessionId,
        turnId,
      );
      if (!anchor || anchor.seq == null) return 0;
      const rows = this.db.all(
        `SELECT id FROM messages WHERE session_id = ? AND seq >= ?`,
        sessionId,
        anchor.seq,
      );
      for (const { id } of rows) this._unlinkMessageBlobs(id);
      this.db.run(`DELETE FROM messages WHERE session_id = ? AND seq >= ?`, sessionId, anchor.seq);
      return rows.length;
    })();
  }

  /** Delete every message for a session, release its blobs, and drop its
   *  runtime events.
   *
   *  Runtime events were INSERTed and UPDATEd but never DELETEd anywhere in the
   *  repo, and clearing a session removed only its messages — so every deleted
   *  conversation left its whole event stream behind forever. Measured on a real
   *  install 2026-09-04: 3,917,891 events across 155 sessions while only 29
   *  sessions still had messages, 2,542,720 of them (64.9%) orphaned from 135
   *  deleted sessions, in a 12 GB database holding 1,156 messages. Almost all of
   *  it is per-token streaming telemetry (process.event, task.step.progress,
   *  assistant.thinking.delta) that has no consumer once the turn is over. */
  clear(sessionId) {
    return this.db.transaction(() => {
      const ids = this.db.all(`SELECT id FROM messages WHERE session_id = ?`, sessionId);
      for (const { id } of ids) this._unlinkMessageBlobs(id);
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, sessionId);
      this.db.run(`DELETE FROM runtime_events WHERE session_id = ?`, sessionId);
    })();
  }

  /** Shrink oversized event payloads in place. See runtime-event-retention. */
  compactRuntimeEventPayloads(options = {}) {
    return runtimeEventRetention.compactRuntimeEventPayloads(this.db, options);
  }

  /** Drop events whose session has no messages left, bounded per call. */
  pruneOrphanRuntimeEvents(options = {}) {
    return runtimeEventRetention.pruneOrphanRuntimeEvents(this.db, options);
  }

  /** Drain a pre-retention install's ephemeral events in index-bounded chunks. */
  pruneHistoricalEphemeralEvents(options = {}) {
    return runtimeEventRetention.pruneHistoricalEphemeralEvents(this.db, options);
  }

  /** The planner's view of one drain chunk, so a gate can prove it is an index
   *  range scan rather than the full table scan a type-only DELETE produces. */
  explainRuntimeEventChunkPlan() {
    const types = runtimeEventRetention.EPHEMERAL_EVENT_TYPES.map(() => "?").join(",");
    return this.db.all(
      `EXPLAIN QUERY PLAN SELECT 1 FROM runtime_events
        WHERE session_id = ? AND seq >= ? AND seq < ? AND type IN (${types})`,
      "probe", 0, 1000, ...runtimeEventRetention.EPHEMERAL_EVENT_TYPES,
    ).map((row) => String(row.detail || "")).join("\n");
  }

  /** How many events belong to sessions that no longer have messages. */
  countOrphanRuntimeEvents() {
    return runtimeEventRetention.countOrphanRuntimeEvents(this.db);
  }

  meta(key) {
    const row = this.db.get(`SELECT value FROM schema_meta WHERE key = ?`, key);
    return row ? row.value : null;
  }
  setMeta(key, value) {
    this.db.run(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, String(value),
    );
  }
  deleteMeta(key) {
    this.db.run(`DELETE FROM schema_meta WHERE key = ?`, key);
  }
  /** Meta keys under a prefix — for sweeping bookkeeping left by an earlier schema version. */
  metaKeys(prefix = "") {
    const like = `${String(prefix).replace(/[\\%_]/g, "\\$&")}%`;
    return this.db
      .all(`SELECT key FROM schema_meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC`, like)
      .map((row) => row.key);
  }
  agents() { return this._agents ||= new (require("../agents/agent-repository").AgentRepository)(this); }
  characterWorlds() { return this._characterWorlds ||= new (require("../character-worlds/repository").CharacterWorldsRepository)(this); }
  close() {
    this.db.close();
  }
}

const turnInputMethods = require("./turn-input-store");
Object.defineProperties(
  MessageStore.prototype,
  Object.fromEntries(Object.entries(turnInputMethods).map(([name, value]) => [
    name,
    { configurable: true, writable: true, value },
  ])),
);
const taskResultMethods = require("./task-result-store").createTaskResultStoreMethods();
Object.defineProperties(
  MessageStore.prototype,
  Object.fromEntries(Object.entries(taskResultMethods).map(([name, value]) => [
    name,
    { configurable: true, writable: true, value },
  ])),
);
const taskLifecycleMethods = require("./task-lifecycle-store").createTaskLifecycleStoreMethods();
Object.defineProperties(
  MessageStore.prototype,
  Object.fromEntries(Object.entries(taskLifecycleMethods).map(([name, value]) => [
    name,
    { configurable: true, writable: true, value },
  ])),
);
const taskContextRegistryMethods = require("./task-context-registry-store").createTaskContextRegistryStoreMethods();
Object.defineProperties(
  MessageStore.prototype,
  Object.fromEntries(Object.entries(taskContextRegistryMethods).map(([name, value]) => [
    name,
    { configurable: true, writable: true, value },
  ])),
);
require("./message-read-store").attachMessageReadMethods(MessageStore);
require("./parent-closure-recovery-attach")(MessageStore);
module.exports = { MessageStore };
