#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "character-worlds-experience-migration-"));
const dbPath = path.join(root, "messages.db");
const db = openDatabase(dbPath);

function columns(table) {
  return db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
}

function indexes(table) {
  return db.all(`PRAGMA index_list(${table})`).map((row) => row.name);
}

try {
  assert.ok(MIGRATIONS.length >= 15, "experience schema remains migration v15");
  db.migrate(MIGRATIONS.slice(0, 14));
  assert.equal(db.pragma("user_version"), 14);

  db.run(
    `INSERT INTO turn_inputs
       (session_id, admitted_seq, turn_id, delivery, status, user_text,
        files_json, metadata_json, created_at)
     VALUES (?, ?, ?, 'direct', 'admitted', 'hello', '[]', '{}', ?)`,
    "legacy-session", 1, "legacy-turn", 1000,
  );

  db.migrate(MIGRATIONS);
  assert.equal(db.pragma("user_version"), MIGRATIONS.length);
  assert.equal(
    db.get("SELECT turn_id FROM turn_inputs WHERE session_id = ?", "legacy-session").turn_id,
    "legacy-turn",
    "v14 turn data survives the additive migration",
  );

  assert.deepEqual(columns("character_worlds_receipts"), [
    "id",
    "owner_scope",
    "session_id",
    "turn_id",
    "tool_call_id",
    "kind",
    "entity_id",
    "revision_id",
    "safe_json",
    "created_at",
  ]);
  assert.ok(
    indexes("character_worlds_receipts").includes("idx_character_worlds_receipt_turn"),
    "receipt lookup is indexed by owner/session/turn",
  );

  db.run(
    `INSERT INTO character_worlds_receipts
       (id, owner_scope, session_id, turn_id, tool_call_id, kind,
        entity_id, revision_id, safe_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "receipt-1", "owner-a", "session-a", "turn-a", "call-a", "character",
    "entity-a", "revision-a", "{}", 2000,
  );
  assert.throws(
    () => db.run(
      "UPDATE character_worlds_receipts SET revision_id = ? WHERE id = ?",
      "revision-b", "receipt-1",
    ),
    /immutable/,
    "receipt rows are append-only evidence",
  );

  assert.deepEqual(columns("character_session_previews"), [
    "session_id",
    "owner_scope",
    "preview_version",
    "preview_json",
    "created_at",
    "updated_at",
  ]);
  assert.ok(
    indexes("character_session_previews").includes("idx_character_session_preview_owner"),
    "preview lookup is owner scoped",
  );
  db.run(
    `INSERT INTO character_session_previews
       (session_id, owner_scope, preview_version, preview_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    "session-a", "owner-a", 1, "{}", 2000, 2000,
  );
  assert.throws(
    () => db.run(
      `INSERT INTO character_session_previews
         (session_id, owner_scope, preview_version, preview_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "session-a", "owner-a", 2, "{}", 2001, 2001,
    ),
    /UNIQUE constraint failed/,
    "one owner/session has one CAS preview row",
  );

  assert.ok(
    columns("turn_inputs").includes("character_worlds_snapshot_json"),
    "turn admission can persist the exact effective Character Worlds snapshot",
  );

  console.log("PASS: test-character-worlds-experience-migration");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
