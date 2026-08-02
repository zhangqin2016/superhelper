"use strict";

function migrateCharacterWorldsExperienceSchema(db) {
  db.exec(`
    CREATE TABLE character_worlds_receipts (
      id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('character', 'persona', 'worldBook')),
      entity_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      safe_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(owner_scope, session_id, turn_id, tool_call_id)
    );
    CREATE INDEX idx_character_worlds_receipt_turn
      ON character_worlds_receipts(owner_scope, session_id, turn_id);
    CREATE TRIGGER character_worlds_receipts_no_update
      BEFORE UPDATE ON character_worlds_receipts BEGIN
        SELECT RAISE(ABORT, 'character_worlds_receipts are immutable');
      END;
    CREATE TRIGGER character_worlds_receipts_no_delete
      BEFORE DELETE ON character_worlds_receipts BEGIN
        SELECT RAISE(ABORT, 'character_worlds_receipts are immutable');
      END;

    CREATE TABLE character_session_previews (
      session_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      preview_version INTEGER NOT NULL CHECK (preview_version >= 1),
      preview_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, owner_scope)
    );
    CREATE INDEX idx_character_session_preview_owner
      ON character_session_previews(owner_scope, session_id);

    ALTER TABLE turn_inputs
      ADD COLUMN character_worlds_snapshot_json TEXT;
  `);
}

module.exports = { migrateCharacterWorldsExperienceSchema };
