"use strict";

/**
 * Reading committed messages.
 *
 * Every query here is a pure read over the `messages` table plus envelope
 * unpacking, which is why they sit apart from the store that owns writes,
 * blobs, migrations and the turn/runtime-event projections. Mixed into
 * MessageStore.prototype, so each one still runs with `this` as the store.
 *
 * One property matters to callers beyond tidiness: `messageSlice` is the
 * BOUNDED read. Maintenance passes must never load a whole conversation — a
 * customer with a 1450-message chat turned a background backfill into one
 * uninterruptible block of main-process work — so the slice carries sequence
 * numbers (which is what lets a pass record where it stopped and resume) and
 * unpacks lazily. [gate: resumable-enrichment]
 */

const { unpack } = require("./message-envelope");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function createMessageReadMethods() {
  return {
    count(sessionId) {
      const row = this.db.get(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ?`, sessionId);
      return row ? row.c : 0;
    },

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
    },

    /** Full chronological history (used to build model context). */
    /**
     * A bounded page of committed messages WITH their sequence numbers.
     *
     * Maintenance passes must never load a whole conversation: a customer with a
     * 1450-message chat turned a background backfill into one uninterruptible
     * block of main-process work. The sequence number is what lets such a pass
     * record where it stopped and resume there. [gate: resumable-enrichment]
     */
    messageSlice(sessionId, afterSeq = 0, limit = 40) {
      const rows = this.db.all(
        `SELECT seq, envelope_blob FROM messages
          WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        sessionId,
        Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0,
        Math.max(1, Math.min(Number(limit) || 40, 500)),
      );
      // Unpacking (decompress + parse) is the expensive half — measured at ~1 ms
      // per record against a fetch of the compressed bytes at ~0.01 ms — so it
      // stays LAZY. A caller working under a time budget then pays only for the
      // records it actually reaches, and its clock can stop the walk between two
      // of them instead of after a whole page has been inflated.
      return rows.map((row) => {
        let message;
        let loaded = false;
        return {
          seq: row.seq,
          get message() {
            if (!loaded) { message = unpack(row.envelope_blob); loaded = true; }
            return message;
          },
        };
      });
    },

    getAll(sessionId) {
      const rows = this.db.all(
        `SELECT envelope_blob FROM messages WHERE session_id = ? ORDER BY seq ASC`,
        sessionId,
      );
      return rows.map((r) => unpack(r.envelope_blob));
    },

    /**
     * Newest `limit` committed messages WITH canonical sequence numbers, in
     * ascending seq order: [{seq, role, speakerName, text}]. This is the
     * world-book scan-corpus projection (§10.4.1): user text comes from
     * envelope.content, assistant text from envelope.record.assistantText, and
     * the speaker name falls back to the role.
     */
    getRecentWithSeq(sessionId, limit = 100) {
      const lim = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
      const rows = this.db.all(
        `SELECT seq, envelope_blob FROM messages
         WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
        sessionId,
        lim,
      );
      rows.reverse(); // chronological
      return rows.map((row) => {
        const envelope = unpack(row.envelope_blob) || {};
        const role = typeof envelope.role === "string" && envelope.role ? envelope.role : "assistant";
        const text = typeof envelope.content === "string" && envelope.content
          ? envelope.content
          : String(envelope.record?.assistantText || "");
        const speakerName = typeof envelope.speakerName === "string" && envelope.speakerName
          ? envelope.speakerName
          : role;
        return { seq: row.seq, role, speakerName, text };
      });
    },

    getById(id) {
      const row = this.db.get(`SELECT envelope_blob FROM messages WHERE id = ?`, id);
      return row ? unpack(row.envelope_blob) : null;
    },

    /** Most recent message of a given role (e.g. last user message for retry). */
    lastOfRole(sessionId, role) {
      const row = this.db.get(
        `SELECT envelope_blob FROM messages WHERE session_id = ? AND role = ?
         ORDER BY seq DESC LIMIT 1`,
        sessionId,
        role,
      );
      return row ? unpack(row.envelope_blob) : null;
    },

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
    },
  };
}

module.exports = { createMessageReadMethods, DEFAULT_LIMIT, MAX_LIMIT };
