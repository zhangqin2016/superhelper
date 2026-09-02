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

// Compaction bounds payload SIZE; it must not erase MEANING. The depth cap used
// to return the literal "[object]", so every persisted question event stored
// `options: ["[object]","[object]","[object]"]` — the choices the user was
// actually offered were unrecoverable on replay. At the cap, keep scalar leaves.
{
  const { compactRuntimeEventForPersistence } = require("../src/main/store/runtime-event-persistence.js");
  const compacted = compactRuntimeEventForPersistence({
    type: "tool.started",
    payload: {
      id: "call_1",
      name: "question",
      input: {
        questions: [{
          question: "视觉语言参照哪款顶级 IM？",
          header: "视觉参照",
          options: [
            { label: "Telegram / Discord 风格（推荐）", description: "深色、克制、消息气泡" },
            { label: "Slack 风格", description: "更密集，强调线程" },
          ],
        }],
      },
    },
  });
  const options = compacted.payload.input.questions[0].options;
  assert.equal(options[0].label, "Telegram / Discord 风格（推荐）", "option labels survive compaction");
  assert.equal(options[1].label, "Slack 风格");
  assert.match(options[0].description, /深色/, "option descriptions survive compaction");
  assert.equal(
    JSON.stringify(compacted).includes("[object]"),
    false,
    "no legible field may be replaced by the useless [object] literal",
  );
  // The cap still caps: deeper nesting under a leaf is dropped, not expanded,
  // and an object with nothing scalar to keep behaves exactly as before.
  const deep = compactRuntimeEventForPersistence({
    type: "tool.started",
    payload: { input: { a: { b: { c: { keep: "yes", drop: { deeper: 1 } } } } } },
  });
  assert.equal(deep.payload.input.a.b.c.keep, "yes");
  assert.equal(deep.payload.input.a.b.c.drop, undefined, "nesting below the cap is still dropped");
  const opaque = compactRuntimeEventForPersistence({
    type: "tool.started",
    payload: { input: { a: { b: { c: { onlyNested: { x: 1 } } } } } },
  });
  assert.equal(opaque.payload.input.a.b.c, "[object]", "an all-nested leaf keeps the old marker");
}

console.log("runtime-event-compaction-index: ok");
