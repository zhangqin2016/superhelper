"use strict";

/**
 * MessageStore — the single source of truth for conversation messages.
 *
 * Replaces the per-session JSON files (which were parsed in full on every
 * session open — the cause of multi-second freezes on large sessions). Reads
 * are bounded keyset queries over an indexed table, so opening a session is
 * O(page) regardless of total history. Writes are single-row inserts in a
 * transaction — O(1), no file rewrite (kills the old O(n²) save).
 *
 * Each stored row keeps cheap "hot" columns (for listing / search / analytics)
 * plus `envelope_blob` = gzip(JSON(message)) with oversized data: URLs swapped
 * for blob refs. A page read decompresses only the rows it returns.
 */

const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { openDatabase } = require("./sqlite-db");
const { BlobStore } = require("./blob-store");
const { MIGRATIONS } = require("./schema");
const { externalize, collectRefs } = require("./record-blobs");

const PREVIEW_MAX = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function pack(envelope) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"));
}

function unpack(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
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
    this.db = openDatabase(dbPath);
    this.db.migrate(MIGRATIONS);
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

  count(sessionId) {
    const row = this.db.get(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ?`, sessionId);
    return row ? row.c : 0;
  }

  /**
   * Keyset pagination. `before` is an exclusive seq cursor (omit for the newest
   * page); the returned `nextBefore` feeds the next (older) call. Conversation
   * is returned in chronological (ascending) order.
   */
  getPage(sessionId, { before, limit } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
    const total = this.count(sessionId);
    const rows = Number.isInteger(before)
      ? this.db.all(
          `SELECT seq, envelope_blob FROM messages
           WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
          sessionId,
          before,
          lim,
        )
      : this.db.all(
          `SELECT seq, envelope_blob FROM messages
           WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
          sessionId,
          lim,
        );
    rows.reverse(); // chronological
    const conversation = rows.map((r) => unpack(r.envelope_blob));
    const minSeq = rows.length ? rows[0].seq : 0;
    const older = rows.length
      ? this.db.get(
          `SELECT 1 AS x FROM messages WHERE session_id = ? AND seq < ? LIMIT 1`,
          sessionId,
          minSeq,
        )
      : null;
    return {
      conversation,
      total,
      hasMore: Boolean(older),
      before: Number.isInteger(before) ? before : null,
      nextBefore: minSeq,
    };
  }

  /** Full chronological history (used to build model context). */
  getAll(sessionId) {
    const rows = this.db.all(
      `SELECT envelope_blob FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      sessionId,
    );
    return rows.map((r) => unpack(r.envelope_blob));
  }

  getById(id) {
    const row = this.db.get(`SELECT envelope_blob FROM messages WHERE id = ?`, id);
    return row ? unpack(row.envelope_blob) : null;
  }

  /** Most recent message of a given role (e.g. last user message for retry). */
  lastOfRole(sessionId, role) {
    const row = this.db.get(
      `SELECT envelope_blob FROM messages WHERE session_id = ? AND role = ?
       ORDER BY seq DESC LIMIT 1`,
      sessionId,
      role,
    );
    return row ? unpack(row.envelope_blob) : null;
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

  /** Delete every message for a session and release its blobs. */
  clear(sessionId) {
    return this.db.transaction(() => {
      const ids = this.db.all(`SELECT id FROM messages WHERE session_id = ?`, sessionId);
      for (const { id } of ids) this._unlinkMessageBlobs(id);
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, sessionId);
    })();
  }

  /** Full-text search over previews. Returns lightweight hits, newest first. */
  search(query, { limit = 50 } = {}) {
    const q = String(query || "").trim();
    if (!q) return [];
    return this.db.all(
      `SELECT m.session_id, m.id, m.role, m.created_at, m.preview
       FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
       WHERE f.preview MATCH ? ORDER BY m.created_at DESC LIMIT ?`,
      q,
      Math.max(1, Math.min(Number(limit) || 50, MAX_LIMIT)),
    );
  }

  meta(key) {
    const row = this.db.get(`SELECT value FROM schema_meta WHERE key = ?`, key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.run(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value),
    );
  }

  close() {
    this.db.close();
  }
}

module.exports = { MessageStore };
