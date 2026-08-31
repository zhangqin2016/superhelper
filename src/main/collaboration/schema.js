"use strict";

// This database is intentionally distinct from store/schema.js. Collaboration
// state is server-rebuildable; an upgrade or corruption here must not touch the
// AI transcript database or workspace metadata.
const COLLABORATION_MIGRATIONS = [
  (db) => db.exec(`
    CREATE TABLE profiles (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, lily_id TEXT, display_name TEXT,
      avatar_object_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (account_id, user_id)
    );
    CREATE TABLE conversations (
      account_id TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (account_id, id)
    );
    CREATE TABLE conversation_members (
      account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT, status TEXT NOT NULL, joined_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, conversation_id, user_id)
    );
    CREATE TABLE events (
      account_id TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT, seq INTEGER,
      type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    );
    CREATE TABLE messages (
      account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
      scope_id TEXT NOT NULL, seq INTEGER, sender_user_id TEXT, state TEXT NOT NULL,
      body_envelope_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, conversation_id, id)
    );
    CREATE INDEX messages_conversation_seq_idx ON messages(account_id, conversation_id, seq);
    CREATE TABLE applied_events (
      account_id TEXT NOT NULL, event_id TEXT NOT NULL, applied_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, event_id)
    );
    CREATE TABLE sync_state (
      account_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, watermark INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE outbox (
      account_id TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      client_command_id TEXT NOT NULL, state TEXT NOT NULL, payload_envelope_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, id), UNIQUE (account_id, client_command_id)
    );
    CREATE INDEX outbox_pending_idx ON outbox(account_id, state, created_at);
    CREATE TABLE drafts (
      account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL,
      content_envelope_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, conversation_id, id)
    );
    CREATE TABLE transfers (
      account_id TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL, state TEXT NOT NULL,
      object_id TEXT, encrypted_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    );
    CREATE TABLE share_mappings (
      account_id TEXT NOT NULL, id TEXT NOT NULL, source_path TEXT, object_id TEXT,
      scope_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, id)
    );
  `),
  // v2 — scope is metadata needed to authorize/decrypt a queued command after
  // restart, and to remove that command when a Team grant is revoked.
  (db) => db.exec(`
    ALTER TABLE outbox ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'personal';
    CREATE INDEX outbox_scope_idx ON outbox(account_id, scope_id, state);
  `),
  // v3 — retry decisions survive restart; an exhausted command must wait for a
  // person rather than retrying forever with a possibly side-effecting intent.
  (db) => db.exec(`ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;`),
  // v4 — a cursor page that contains message activity cannot be ACKed until
  // its server-authorized plaintext history has been persisted locally. This
  // checkpoint survives a crash between SQLite page application and history
  // hydration, so startup can finish hydration before acknowledging later.
  (db) => db.exec(`
    CREATE TABLE history_hydration (
      account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, conversation_id)
    );
  `),
  // v5 — distinguish a server ACK from a transport timeout. Both await the
  // projected history, but only an ACK can release the same-conversation lane.
  (db) => db.exec(`ALTER TABLE outbox ADD COLUMN delivery_confirmed INTEGER NOT NULL DEFAULT 0;`),
  // v6 — command identity is non-secret metadata. Joining it before LIMIT
  // keeps cancelled optimistic aliases out of the visible history window.
  (db) => db.exec(`ALTER TABLE messages ADD COLUMN client_command_id TEXT;
    CREATE INDEX messages_command_idx ON messages(account_id, client_command_id);`),
];

module.exports = { COLLABORATION_MIGRATIONS };
