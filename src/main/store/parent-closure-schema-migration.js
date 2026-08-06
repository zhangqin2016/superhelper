"use strict";

function migrateParentClosureSchema(db) {
  db.exec(`
    CREATE TABLE parent_closure_recoveries (
      session_id       TEXT NOT NULL,
      owner_scope      TEXT NOT NULL,
      source_turn_id   TEXT NOT NULL,
      recovery_key     TEXT NOT NULL,
      recovery_turn_id TEXT NOT NULL,
      status           TEXT NOT NULL,
      source_json      TEXT NOT NULL,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      claim_token      TEXT,
      claim_expires_at INTEGER,
      claimed_at       INTEGER,
      dispatched_at    INTEGER,
      updated_at       INTEGER NOT NULL,
      reason           TEXT,
      PRIMARY KEY (session_id, source_turn_id),
      UNIQUE (owner_scope, recovery_key),
      UNIQUE (owner_scope, recovery_turn_id),
      CHECK (status IN ('prepared', 'claimed', 'dispatched', 'unavailable'))
    );
    CREATE INDEX idx_parent_closure_pending
      ON parent_closure_recoveries(session_id, status, claim_expires_at, updated_at);
  `);
}

module.exports = { migrateParentClosureSchema };
