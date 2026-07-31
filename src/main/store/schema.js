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

const {
  LEGACY_AMBIGUOUS_OWNER_SCOPE,
  migrateLegacyTurnAdmissions,
} = require("./turn-admission-migration");
const {
  migrateLegacyExternalIdentities,
} = require("./turn-admission-mobile-migration");
const {
  migrateWorldBookSchema,
} = require("./world-book-schema-migration");

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
  // v3 - local Character Worlds entities, immutable revisions, and bindings.
  (db) => {
    db.exec(`
      CREATE TABLE character_entities (
        id                  TEXT PRIMARY KEY,
        owner_scope         TEXT NOT NULL,
        display_name        TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        archived_at         INTEGER,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE (id, owner_scope),
        FOREIGN KEY (current_revision_id, id, owner_scope)
          REFERENCES character_revisions(id, entity_id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX idx_character_entities_owner
        ON character_entities(owner_scope, archived_at, updated_at);

      CREATE TABLE character_revisions (
        id                  TEXT PRIMARY KEY,
        entity_id           TEXT NOT NULL,
        owner_scope         TEXT NOT NULL,
        parent_revision_id  TEXT,
        revision_number     INTEGER NOT NULL,
        display_name        TEXT NOT NULL,
        source_kind         TEXT NOT NULL,
        source_format       TEXT NOT NULL,
        source_container    TEXT NOT NULL,
        canonical_json      TEXT NOT NULL,
        source_json         TEXT NOT NULL,
        canonical_hash      TEXT NOT NULL,
        revision_hash       TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        UNIQUE (id, owner_scope),
        UNIQUE (id, entity_id, owner_scope),
        UNIQUE (entity_id, revision_number),
        FOREIGN KEY (entity_id, owner_scope)
          REFERENCES character_entities(id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (parent_revision_id, entity_id, owner_scope)
          REFERENCES character_revisions(id, entity_id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE UNIQUE INDEX idx_character_revision_hash
        ON character_revisions(owner_scope, entity_id, revision_hash);
      CREATE INDEX idx_character_revision_content_hash
        ON character_revisions(owner_scope, entity_id, canonical_hash);

      CREATE TABLE character_revision_blobs (
        revision_id TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        hash        TEXT NOT NULL,
        bytes       INTEGER NOT NULL CHECK (bytes >= 0),
        mime        TEXT CHECK (mime IS NULL OR length(CAST(mime AS BLOB)) <= 255),
        purpose     TEXT NOT NULL CHECK (length(CAST(purpose AS BLOB)) <= 256),
        PRIMARY KEY (revision_id, hash, purpose),
        FOREIGN KEY (revision_id, owner_scope)
          REFERENCES character_revisions(id, owner_scope),
        FOREIGN KEY (hash) REFERENCES blobs(hash)
      );

      CREATE TABLE character_session_bindings (
        session_id             TEXT PRIMARY KEY,
        owner_scope            TEXT NOT NULL,
        binding_version        INTEGER NOT NULL,
        mode                   TEXT NOT NULL,
        character_revision_id  TEXT,
        compatibility_profile  TEXT,
        binding_json           TEXT NOT NULL,
        updated_at              INTEGER NOT NULL,
        UNIQUE (session_id, owner_scope),
        FOREIGN KEY (character_revision_id, owner_scope)
          REFERENCES character_revisions(id, owner_scope)
      );

      CREATE TABLE character_binding_events (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        owner_scope      TEXT NOT NULL,
        binding_version  INTEGER NOT NULL,
        event_json       TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        FOREIGN KEY (session_id, owner_scope)
          REFERENCES character_session_bindings(session_id, owner_scope)
      );
      CREATE UNIQUE INDEX idx_character_binding_event_version
        ON character_binding_events(session_id, binding_version);

      CREATE TABLE persona_entities (
        id                  TEXT PRIMARY KEY,
        owner_scope         TEXT NOT NULL,
        display_name        TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        archived_at         INTEGER,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE (id, owner_scope),
        FOREIGN KEY (current_revision_id, id, owner_scope)
          REFERENCES persona_revisions(id, entity_id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE persona_revisions (
        id                 TEXT PRIMARY KEY,
        entity_id          TEXT NOT NULL,
        owner_scope        TEXT NOT NULL,
        parent_revision_id TEXT,
        revision_number    INTEGER NOT NULL,
        canonical_json     TEXT NOT NULL,
        canonical_hash     TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        UNIQUE (id, entity_id, owner_scope),
        UNIQUE (entity_id, revision_number),
        FOREIGN KEY (entity_id, owner_scope)
          REFERENCES persona_entities(id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (parent_revision_id, entity_id, owner_scope)
          REFERENCES persona_revisions(id, entity_id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE world_book_entities (
        id                  TEXT PRIMARY KEY,
        owner_scope         TEXT NOT NULL,
        display_name        TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        archived_at         INTEGER,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE (id, owner_scope),
        FOREIGN KEY (current_revision_id, id, owner_scope)
          REFERENCES world_book_revisions(id, entity_id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE world_book_revisions (
        id                 TEXT PRIMARY KEY,
        entity_id          TEXT NOT NULL,
        owner_scope        TEXT NOT NULL,
        parent_revision_id TEXT,
        revision_number    INTEGER NOT NULL,
        canonical_json     TEXT NOT NULL,
        canonical_hash     TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        UNIQUE (id, entity_id, owner_scope),
        UNIQUE (entity_id, revision_number),
        FOREIGN KEY (entity_id, owner_scope)
          REFERENCES world_book_entities(id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (parent_revision_id, entity_id, owner_scope)
          REFERENCES world_book_revisions(id, entity_id, owner_scope)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE character_scene_checkpoints (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        owner_scope      TEXT NOT NULL,
        turn_id          TEXT,
        checkpoint_json  TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );

      CREATE TRIGGER character_revisions_no_update
      BEFORE UPDATE ON character_revisions BEGIN
        SELECT RAISE(ABORT, 'character_revisions rows are immutable');
      END;
      CREATE TRIGGER character_revisions_no_delete
      BEFORE DELETE ON character_revisions BEGIN
        SELECT RAISE(ABORT, 'character_revisions rows are immutable');
      END;
      CREATE TRIGGER character_revision_blobs_no_update
      BEFORE UPDATE ON character_revision_blobs BEGIN
        SELECT RAISE(ABORT, 'character_revision_blobs rows are immutable');
      END;
      CREATE TRIGGER character_revision_blobs_no_delete
      BEFORE DELETE ON character_revision_blobs BEGIN
        SELECT RAISE(ABORT, 'character_revision_blobs rows are immutable');
      END;
      CREATE TRIGGER character_binding_events_no_update
      BEFORE UPDATE ON character_binding_events BEGIN
        SELECT RAISE(ABORT, 'character_binding_events are append-only');
      END;
      CREATE TRIGGER character_binding_events_no_delete
      BEFORE DELETE ON character_binding_events BEGIN
        SELECT RAISE(ABORT, 'character_binding_events are append-only');
      END;
      CREATE TRIGGER persona_revisions_no_update
      BEFORE UPDATE ON persona_revisions BEGIN
        SELECT RAISE(ABORT, 'persona_revisions rows are immutable');
      END;
      CREATE TRIGGER persona_revisions_no_delete
      BEFORE DELETE ON persona_revisions BEGIN
        SELECT RAISE(ABORT, 'persona_revisions rows are immutable');
      END;
      CREATE TRIGGER world_book_revisions_no_update
      BEFORE UPDATE ON world_book_revisions BEGIN
        SELECT RAISE(ABORT, 'world_book_revisions rows are immutable');
      END;
      CREATE TRIGGER world_book_revisions_no_delete
      BEFORE DELETE ON world_book_revisions BEGIN
        SELECT RAISE(ABORT, 'world_book_revisions rows are immutable');
      END;
    `);
  },
  // v4 - transaction-safe owner-scoped character import deduplication.
  (db) => {
    db.exec(`
      ALTER TABLE character_revisions
        ADD COLUMN original_hash TEXT
        CHECK (
          original_hash IS NULL
          OR (
            length(original_hash) = 64
            AND original_hash NOT GLOB '*[^a-f0-9]*'
          )
        );
      CREATE UNIQUE INDEX idx_character_revision_owner_original
        ON character_revisions(owner_scope, original_hash)
        WHERE original_hash IS NOT NULL;
      CREATE INDEX idx_character_revision_owner_canonical
        ON character_revisions(owner_scope, canonical_hash, created_at, id);
    `);
  },
  // v5 - at-most-once durable turn dispatch state.
  (db) => {
    db.exec(`
      ALTER TABLE turn_inputs ADD COLUMN dispatch_attempt_id TEXT;
      ALTER TABLE turn_inputs ADD COLUMN dispatch_started_at INTEGER;
      ALTER TABLE turn_inputs ADD COLUMN accepted_at INTEGER;
    `);
  },
  // v6 - owner/session-scoped durable turn admission idempotency keys.
  (db) => {
    db.exec(`
      ALTER TABLE turn_inputs
        ADD COLUMN owner_scope TEXT NOT NULL DEFAULT '${LEGACY_AMBIGUOUS_OWNER_SCOPE}';
      ALTER TABLE turn_inputs
        ADD COLUMN migration_status TEXT NOT NULL DEFAULT 'legacy_ambiguous';
      ALTER TABLE turn_inputs
        ADD COLUMN migration_reason TEXT NOT NULL DEFAULT 'legacy_unclassified';
      ALTER TABLE turn_inputs
        ADD COLUMN scheduled_session_barrier INTEGER NOT NULL DEFAULT 0
        CHECK (scheduled_session_barrier IN (0, 1));
      ALTER TABLE turn_inputs ADD COLUMN scheduled_task_run_id TEXT;
      ALTER TABLE turn_inputs ADD COLUMN external_command_id TEXT;
      ALTER TABLE turn_inputs ADD COLUMN external_idempotency_key TEXT;
      ALTER TABLE turn_inputs ADD COLUMN external_payload_hash TEXT;
    `);
    migrateLegacyTurnAdmissions(db);
    db.exec(`
      CREATE UNIQUE INDEX idx_turn_inputs_scheduled_admission
        ON turn_inputs(owner_scope, session_id, scheduled_task_run_id)
        WHERE scheduled_task_run_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_turn_inputs_external_admission
        ON turn_inputs(owner_scope, session_id, external_command_id)
        WHERE external_command_id IS NOT NULL;
      CREATE INDEX idx_turn_inputs_owner_session_status
        ON turn_inputs(owner_scope, migration_status, session_id, status, admitted_seq);
      CREATE INDEX idx_turn_inputs_quarantine_scheduled
        ON turn_inputs(owner_scope, session_id, scheduled_task_run_id)
        WHERE scheduled_task_run_id IS NOT NULL
          AND migration_status <> 'owned';
      CREATE INDEX idx_turn_inputs_quarantine_external
        ON turn_inputs(owner_scope, session_id, external_command_id)
        WHERE external_command_id IS NOT NULL
          AND migration_status <> 'owned';
      CREATE INDEX idx_turn_inputs_quarantine_scheduled_session
        ON turn_inputs(owner_scope, session_id, scheduled_session_barrier)
        WHERE scheduled_session_barrier = 1
          AND migration_status <> 'owned';
    `);
  },
  // v7 - canonical Mobile Command device-tuple idempotency.
  (db) => {
    db.exec(`
      ALTER TABLE turn_inputs ADD COLUMN external_desktop_device_id TEXT;
      ALTER TABLE turn_inputs ADD COLUMN external_mobile_device_id TEXT;
    `);
    migrateLegacyExternalIdentities(db);
    db.exec(`
      CREATE UNIQUE INDEX idx_turn_inputs_external_idempotency
        ON turn_inputs(
          external_desktop_device_id,
          external_mobile_device_id,
          external_idempotency_key
        )
        WHERE external_desktop_device_id IS NOT NULL
          AND external_mobile_device_id IS NOT NULL
          AND external_idempotency_key IS NOT NULL;
    `);
  },
  // v8 - world book revision parity with character revisions (Phase 2 WB-1).
  // Additive only: v3 world_book placeholder tables gain the full
  // provenance/hash/blob discipline; existing character tables and rows are
  // untouched. The SQL lives in world-book-schema-migration.js to keep this
  // file within the architecture line budget.
  migrateWorldBookSchema,
  // v9 - character revisions pin their imported embedded world book revision
  // (Phase 2 WB-2). Additive nullable column; imports insert the world-book
  // revision in the same transaction before the character revision, so the
  // immediate FK always sees a committed-in-transaction parent row.
  (db) => {
    db.exec(`
      ALTER TABLE character_revisions
        ADD COLUMN character_book_revision_id TEXT
        REFERENCES world_book_revisions(id);
    `);
  },
];

module.exports = { MIGRATIONS };
