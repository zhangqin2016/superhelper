"use strict";

/**
 * Schema v8 - world book revision parity with character revisions
 * (Phase 2, Task WB-1).
 *
 * The v3 world_book tables were forward-compatible placeholders; this brings
 * them to the full character_revisions discipline. SQLite cannot add a
 * NOT NULL column without a default, so provenance/hash columns default to
 * '' (placeholder rows only ever existed in tests; the repository always
 * writes every column explicitly). The v3 placeholder table also lacks the
 * UNIQUE (id, owner_scope) constraint character_revisions has, so a unique
 * index supplies the FK parent key for world_book_revision_blobs.
 *
 * Hypothetical pre-v8 rows (the v3 placeholder shape was never written by any
 * shipped code path, but a database could carry rows from development builds)
 * get '' for every added column. They are backfilled with distinct
 * 'legacy:<id>' revision hashes so the dedup index can be created; their
 * source_json '' is NOT a valid packed envelope, so they are deliberately not
 * readable through getWorldBookRevision (unpackJson would throw) — treat them
 * as orphaned placeholders, never as readable world-book data.
 */
function migrateWorldBookSchema(db) {
  db.exec(`
    ALTER TABLE world_book_revisions
      ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE world_book_revisions
      ADD COLUMN source_kind TEXT NOT NULL DEFAULT '';
    ALTER TABLE world_book_revisions
      ADD COLUMN source_format TEXT NOT NULL DEFAULT '';
    ALTER TABLE world_book_revisions
      ADD COLUMN source_container TEXT NOT NULL DEFAULT '';
    ALTER TABLE world_book_revisions
      ADD COLUMN source_json TEXT NOT NULL DEFAULT '';
    ALTER TABLE world_book_revisions
      ADD COLUMN revision_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE world_book_revisions
      ADD COLUMN original_hash TEXT
      CHECK (
        original_hash IS NULL
        OR (
          length(original_hash) = 64
          AND original_hash NOT GLOB '*[^a-f0-9]*'
        )
      );

    -- Backfill hypothetical pre-v8 placeholder rows (added columns default to
    -- '') with distinct legacy hashes so the dedup index below can be created.
    -- The v3 immutability trigger blocks UPDATE, so it is dropped and
    -- recreated identically around the backfill; the migration runs in one
    -- transaction, so a crash rolls the trigger back too.
    DROP TRIGGER IF EXISTS world_book_revisions_no_update;
    UPDATE world_book_revisions
      SET revision_hash = 'legacy:' || id
      WHERE revision_hash = '';
    CREATE TRIGGER world_book_revisions_no_update
    BEFORE UPDATE ON world_book_revisions BEGIN
      SELECT RAISE(ABORT, 'world_book_revisions rows are immutable');
    END;

    CREATE UNIQUE INDEX idx_world_book_revision_hash
      ON world_book_revisions(owner_scope, entity_id, revision_hash);
    CREATE UNIQUE INDEX idx_world_book_revisions_id_owner
      ON world_book_revisions(id, owner_scope);
    CREATE INDEX idx_world_book_revision_content_hash
      ON world_book_revisions(owner_scope, entity_id, canonical_hash);
    CREATE UNIQUE INDEX idx_world_book_revision_owner_original
      ON world_book_revisions(owner_scope, original_hash)
      WHERE original_hash IS NOT NULL;
    CREATE INDEX idx_world_book_revision_owner_canonical
      ON world_book_revisions(owner_scope, canonical_hash, created_at, id);
    CREATE INDEX idx_world_book_entities_owner
      ON world_book_entities(owner_scope, archived_at, updated_at);

    CREATE TABLE world_book_revision_blobs (
      revision_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      hash        TEXT NOT NULL,
      bytes       INTEGER NOT NULL CHECK (bytes >= 0),
      mime        TEXT CHECK (mime IS NULL OR length(CAST(mime AS BLOB)) <= 255),
      purpose     TEXT NOT NULL CHECK (length(CAST(purpose AS BLOB)) <= 256),
      PRIMARY KEY (revision_id, hash, purpose),
      FOREIGN KEY (revision_id, owner_scope)
        REFERENCES world_book_revisions(id, owner_scope),
      FOREIGN KEY (hash) REFERENCES blobs(hash)
    );

    CREATE TRIGGER world_book_revision_blobs_no_update
    BEFORE UPDATE ON world_book_revision_blobs BEGIN
      SELECT RAISE(ABORT, 'world_book_revision_blobs rows are immutable');
    END;
    CREATE TRIGGER world_book_revision_blobs_no_delete
    BEFORE DELETE ON world_book_revision_blobs BEGIN
      SELECT RAISE(ABORT, 'world_book_revision_blobs rows are immutable');
    END;
  `);
}

module.exports = { migrateWorldBookSchema };
