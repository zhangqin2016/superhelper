#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");

const db = openDatabase(":memory:");
try {
  db.migrate(MIGRATIONS);
  const indexes = db.all("PRAGMA index_list(runtime_events)").map((row) => row.name);
  assert.ok(
    indexes.includes("idx_runtime_events_compaction_candidates"),
    "runtime-event maintenance needs an index-backed candidate scan",
  );

  const plan = db.all(`
    EXPLAIN QUERY PLAN
    SELECT session_id, seq, id, turn_id, type, source, ts, payload_json
    FROM runtime_events
    WHERE length(payload_json) > 20000
      AND payload_json NOT LIKE '%"persistenceCompact":true%'
      AND type IN (
        'process.event',
        'subagent.event',
        'tool.started',
        'tool.input.done',
        'tool.done',
        'user.committed',
        'assistant.final',
        'turn.completed',
        'turn.failed',
        'turn.interrupted',
        'turn.stalled'
      )
    ORDER BY length(payload_json) DESC
    LIMIT 200
  `).map((row) => String(row.detail || "")).join("\n");
  assert.match(
    plan,
    /idx_runtime_events_compaction_candidates/,
    `candidate query must use the bounded compaction index:\n${plan}`,
  );
  assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/, `query must not sort the full table:\n${plan}`);
} finally {
  db.close();
}

console.log("runtime-event-compaction-index: ok");
