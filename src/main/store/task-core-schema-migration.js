"use strict";

/**
 * Durable task-core envelope for admitted turns.
 *
 * The envelope is deliberately separate from metadata_json: metadata is a
 * compatibility surface that may be merged by queue/terminal projections;
 * taskCore is an immutable execution fact and must never be overwritten by a
 * later projection.
 */
function migrateTaskCoreSchema(db) {
  db.exec(`
    ALTER TABLE turn_inputs ADD COLUMN task_core_json TEXT;
    ALTER TABLE turn_inputs ADD COLUMN task_core_fingerprint TEXT;
    CREATE INDEX idx_turn_inputs_task_core
      ON turn_inputs(owner_scope, session_id, task_core_fingerprint)
      WHERE task_core_fingerprint IS NOT NULL;
    CREATE TABLE task_results (
      session_id          TEXT NOT NULL,
      owner_scope         TEXT NOT NULL,
      task_id             TEXT NOT NULL,
      turn_id             TEXT NOT NULL,
      attempt_id          TEXT,
      terminal_type       TEXT NOT NULL,
      verification_json   TEXT NOT NULL DEFAULT '{}',
      delivery_status     TEXT NOT NULL DEFAULT 'pending',
      delivery_json       TEXT NOT NULL DEFAULT '{}',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_id),
      UNIQUE (owner_scope, task_id, turn_id)
    );
    CREATE INDEX idx_task_results_owner_task
      ON task_results(owner_scope, task_id, updated_at);
  `);
}

module.exports = { migrateTaskCoreSchema };
