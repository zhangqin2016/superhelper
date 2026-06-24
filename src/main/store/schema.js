"use strict";

/**
 * Ordered schema migrations for the message database.
 *
 * Each entry's array index maps to the target `PRAGMA user_version` (entry 0
 * brings a fresh db to version 1). Never edit or reorder an existing entry —
 * append a new one. This is what keeps the store upgradeable without a rewrite.
 *
 * Scope note: this database owns MESSAGES + their BLOBS + the FTS index — the
 * heavy, unbounded, perf-critical data. Session/project metadata stays in the
 * existing lightweight JSON index (it is small and not the bottleneck). The
 * boundary is deliberate: catalog (JSON) vs. content (SQLite). Adding a
 * sessions table later is purely additive.
 */

const MIGRATIONS = [
  // v1 — initial message store
  (db) => {
    db.exec(`
      CREATE TABLE schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- One row per message (user or assistant turn). Hot columns are duplicated
      -- out of the envelope for cheap listing/search/analytics without inflating;
      -- the authoritative payload is envelope_blob (gzip(JSON(message))) with
      -- oversized data: URLs swapped for blob refs before compression.
      CREATE TABLE messages (
        session_id    TEXT    NOT NULL,
        seq           INTEGER NOT NULL,          -- monotonic per session = order
        id            TEXT    NOT NULL,          -- msg_uuid, stable external id
        role          TEXT    NOT NULL,          -- 'user' | 'assistant'
        turn_id       TEXT,
        created_at    INTEGER NOT NULL,          -- epoch ms
        preview       TEXT,                      -- trimmed content/assistantText
        failed        INTEGER NOT NULL DEFAULT 0,
        terminal      TEXT,
        cost_usd      REAL,
        duration_ms   INTEGER,
        envelope_blob BLOB,                       -- gzip(JSON(full message))
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX idx_messages_id ON messages(id);

      -- Content-addressed blob catalog. Bytes live on disk under blobs/<hh>/<hash>.
      CREATE TABLE blobs (
        hash       TEXT PRIMARY KEY,             -- sha256 hex
        bytes      INTEGER NOT NULL,
        mime       TEXT,
        refcount   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      -- message <-> blob mapping, drives refcount GC on message delete.
      CREATE TABLE message_blobs (
        message_id TEXT NOT NULL,
        hash       TEXT NOT NULL,
        PRIMARY KEY (message_id, hash)
      );

      -- Full-text search over previews (external-content FTS kept in sync by
      -- triggers below). Predeclared so search is free when the UI wants it.
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        preview,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, preview) VALUES (new.rowid, new.preview);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, preview)
          VALUES('delete', old.rowid, old.preview);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, preview)
          VALUES('delete', old.rowid, old.preview);
        INSERT INTO messages_fts(rowid, preview) VALUES (new.rowid, new.preview);
      END;
    `);
  },
  // v2 — durable turn admission + replayable runtime projection.
  (db) => {
    db.exec(`
      CREATE TABLE turn_inputs (
        session_id    TEXT    NOT NULL,
        admitted_seq  INTEGER NOT NULL,
        turn_id       TEXT    NOT NULL,
        delivery      TEXT    NOT NULL DEFAULT 'queue',
        status        TEXT    NOT NULL DEFAULT 'admitted',
        user_text     TEXT    NOT NULL DEFAULT '',
        files_json    TEXT    NOT NULL DEFAULT '[]',
        metadata_json TEXT    NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        promoted_at   INTEGER,
        terminal_at   INTEGER,
        terminal_type TEXT,
        error_code    TEXT,
        PRIMARY KEY (session_id, admitted_seq)
      );
      CREATE UNIQUE INDEX idx_turn_inputs_turn_id ON turn_inputs(turn_id);
      CREATE INDEX idx_turn_inputs_pending ON turn_inputs(session_id, status, admitted_seq);

      CREATE TABLE runtime_events (
        session_id       TEXT    NOT NULL,
        seq              INTEGER NOT NULL,
        id               TEXT    NOT NULL,
        turn_id          TEXT,
        type             TEXT    NOT NULL,
        source           TEXT    NOT NULL,
        ts               INTEGER NOT NULL,
        payload_json     TEXT    NOT NULL DEFAULT '{}',
        original_type    TEXT,
        original_event_id TEXT,
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX idx_runtime_events_id ON runtime_events(id);
      CREATE INDEX idx_runtime_events_turn ON runtime_events(session_id, turn_id, seq);

      CREATE TABLE turn_projection (
        session_id      TEXT    NOT NULL,
        turn_id         TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'running',
        user_text       TEXT    NOT NULL DEFAULT '',
        assistant_text  TEXT    NOT NULL DEFAULT '',
        thinking_text   TEXT    NOT NULL DEFAULT '',
        activity_label  TEXT,
        tool_count      INTEGER NOT NULL DEFAULT 0,
        notice_count    INTEGER NOT NULL DEFAULT 0,
        started_at      INTEGER,
        updated_at      INTEGER NOT NULL,
        terminal_at     INTEGER,
        terminal_type   TEXT,
        payload_json    TEXT    NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, turn_id)
      );
    `);
  },
];

module.exports = { MIGRATIONS };
