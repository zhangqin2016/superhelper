"use strict";

/**
 * 智能体（Agent）storage. Mirrors the character-worlds discipline: immutable
 * revisions (triggers), owner-scoped entities, a per-session binding with a
 * monotonically increasing version for CAS, and an append-only event log.
 * Additive only — nothing existing is touched.
 */
function migrateAgentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_entities (
      id                  TEXT PRIMARY KEY,
      owner_scope         TEXT NOT NULL,
      display_name        TEXT NOT NULL,
      current_revision_id TEXT,
      official_id         TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      archived_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_entities_owner
      ON agent_entities(owner_scope, archived_at, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_entities_official
      ON agent_entities(owner_scope, official_id)
      WHERE official_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_revisions (
      id                 TEXT PRIMARY KEY,
      entity_id          TEXT NOT NULL,
      owner_scope        TEXT NOT NULL,
      parent_revision_id TEXT,
      revision_number    INTEGER NOT NULL CHECK (revision_number >= 1),
      display_name       TEXT NOT NULL,
      definition_json    TEXT NOT NULL,
      definition_hash    TEXT NOT NULL,
      source_kind        TEXT NOT NULL,
      source_json        TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      UNIQUE(owner_scope, entity_id, revision_number),
      FOREIGN KEY (entity_id) REFERENCES agent_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_revisions_entity
      ON agent_revisions(owner_scope, entity_id, revision_number);
    CREATE TRIGGER IF NOT EXISTS agent_revisions_no_update
      BEFORE UPDATE ON agent_revisions BEGIN
        SELECT RAISE(ABORT, 'agent_revisions rows are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS agent_revisions_no_delete
      BEFORE DELETE ON agent_revisions BEGIN
        SELECT RAISE(ABORT, 'agent_revisions rows are immutable');
      END;

    CREATE TABLE IF NOT EXISTS agent_session_bindings (
      session_id        TEXT PRIMARY KEY,
      owner_scope       TEXT NOT NULL,
      binding_version   INTEGER NOT NULL CHECK (binding_version >= 0),
      agent_entity_id   TEXT,
      agent_revision_id TEXT,
      binding_json      TEXT NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_session_bindings_owner
      ON agent_session_bindings(owner_scope, agent_entity_id);

    CREATE TABLE IF NOT EXISTS agent_binding_events (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      owner_scope     TEXT NOT NULL,
      binding_version INTEGER NOT NULL,
      event_json      TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_binding_event_version
      ON agent_binding_events(session_id, binding_version);
    CREATE TRIGGER IF NOT EXISTS agent_binding_events_no_update
      BEFORE UPDATE ON agent_binding_events BEGIN
        SELECT RAISE(ABORT, 'agent_binding_events are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS agent_binding_events_no_delete
      BEFORE DELETE ON agent_binding_events BEGIN
        SELECT RAISE(ABORT, 'agent_binding_events are append-only');
      END;
  `);
}

module.exports = { migrateAgentSchema };
