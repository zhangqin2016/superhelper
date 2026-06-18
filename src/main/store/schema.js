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
];

module.exports = { MIGRATIONS };
