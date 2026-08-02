"use strict";

function migrateCharacterWorldsRuntimeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_scene_memory (
      id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, session_id TEXT NOT NULL,
      character_revision_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, normalized_hash TEXT NOT NULL, source_turn_ids TEXT NOT NULL,
      source_hash TEXT NOT NULL, confidence TEXT NOT NULL, supersedes_id TEXT,
      created_at INTEGER NOT NULL, invalidated_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_character_scene_memory_dedup
      ON character_scene_memory(owner_scope, session_id, character_revision_id, normalized_hash, source_hash);
    CREATE INDEX IF NOT EXISTS idx_character_scene_memory_scope
      ON character_scene_memory(owner_scope, session_id, character_revision_id, created_at);
    CREATE TABLE IF NOT EXISTS character_scene_memory_checkpoints (
      owner_scope TEXT NOT NULL, session_id TEXT NOT NULL, character_revision_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, memory_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(owner_scope, session_id, character_revision_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS group_scenes (
      id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, session_id TEXT NOT NULL,
      participant_character_revision_ids TEXT NOT NULL, active_speaker_revision_id TEXT,
      reply_strategy TEXT NOT NULL, prompt_mode TEXT NOT NULL,
      allow_multiple_speakers INTEGER NOT NULL DEFAULT 1,
      allow_self_responses INTEGER NOT NULL DEFAULT 0,
      muted_character_revision_ids TEXT NOT NULL DEFAULT '[]',
      last_speaker_revision_ids TEXT NOT NULL DEFAULT '[]',
      active_greeting_index_by_revision_id TEXT NOT NULL DEFAULT '{}',
      scenario_override TEXT NOT NULL DEFAULT '', scene_state TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_scenes_owner ON group_scenes(owner_scope, session_id);
    CREATE TABLE IF NOT EXISTS group_response_variants (
      id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL DEFAULT 'device:local',
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, variant_id TEXT NOT NULL,
      text TEXT NOT NULL, binding_snapshot_json TEXT NOT NULL DEFAULT '{}',
      side_effecting INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
  `);
}

module.exports = { migrateCharacterWorldsRuntimeSchema };
