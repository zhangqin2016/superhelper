#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");

const db = openDatabase(":memory:");
try {
  db.migrate(MIGRATIONS);
  const indexes = db.all("PRAGMA index_list(messages)").map((row) => row.name);
  assert.ok(
    indexes.includes("idx_messages_session_turn_role"),
    "turn recovery needs a covering message index instead of scanning every message in each session",
  );

  const plan = db.all(`
    EXPLAIN QUERY PLAN
    SELECT ti.* FROM turn_inputs ti
    WHERE ti.session_id = 'session-a'
      AND ti.migration_status = 'owned'
      AND ti.status = 'admitted'
      AND ti.delivery = 'queue'
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.session_id = ti.session_id
          AND m.turn_id = ti.turn_id
          AND m.role = 'assistant'
      )
    ORDER BY admitted_seq ASC
  `).map((row) => String(row.detail || "")).join("\n");
  assert.match(plan, /idx_messages_session_turn_role/, `query plan must use the covering index:\n${plan}`);
} finally {
  db.close();
}

console.log("turn-recovery-message-index: ok");
