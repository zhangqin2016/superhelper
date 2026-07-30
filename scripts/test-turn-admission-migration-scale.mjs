#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ownerScopeFromPrincipal } = require(
  "../src/main/character-worlds/owner-scope.js",
);
const { MIGRATIONS } = require("../src/main/store/schema.js");
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const {
  MAX_SCHEDULED_EVIDENCE_ROWS,
  SCHEDULED_EVIDENCE_BATCH_SQL,
} = require("../src/main/store/turn-admission-migration-scheduled.js");

assert.equal(typeof SCHEDULED_EVIDENCE_BATCH_SQL, "string");
assert.ok(MAX_SCHEDULED_EVIDENCE_ROWS >= 10_000);

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "turn-admission-migration-scale-"),
);
const dbPath = path.join(root, "messages.db");
const scheduledPath = path.join(root, "scheduled-tasks.db");
const ownerPrincipal = "user:migration-scale-owner";
const ownerScope = ownerScopeFromPrincipal(ownerPrincipal);
const rowCount = 10_000;

let db;
let scheduled;
try {
  db = openDatabase(dbPath);
  db.migrate(MIGRATIONS.slice(0, 5));
  const insertTurn = db.raw.prepare(
    `INSERT INTO turn_inputs
       (session_id, admitted_seq, turn_id, delivery, status, user_text,
        files_json, metadata_json, created_at)
     VALUES (?, ?, ?, 'queue', 'admitted', ?, '[]', ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < rowCount; index += 1) {
      const sessionId = `scale-session-${index}`;
      const turnId = `scale-turn-${index}`;
      const runId = `scale-run-${index}`;
      insertTurn.run(
        sessionId,
        1,
        turnId,
        turnId,
        JSON.stringify({
          scheduledTaskRunId: runId,
          scheduledTaskId: `scale-task-${index}`,
        }),
        1000 + index,
      );
    }
  })();

  scheduled = openDatabase(scheduledPath);
  scheduled.exec(`
    CREATE TABLE scheduled_task_runs (
      id TEXT PRIMARY KEY,
      owner_principal TEXT NOT NULL,
      execution_session_id TEXT NOT NULL,
      turn_id TEXT
    );
  `);
  const plan = scheduled.all(
    `EXPLAIN QUERY PLAN ${SCHEDULED_EVIDENCE_BATCH_SQL}`,
    0,
    1000,
  );
  assert.ok(
    plan.some((row) => /INTEGER PRIMARY KEY|rowid/i.test(String(row.detail))),
    `scheduled evidence batches must use rowid/index search: ${JSON.stringify(plan)}`,
  );
  const insertRun = scheduled.raw.prepare(
    `INSERT INTO scheduled_task_runs
       (id, owner_principal, execution_session_id, turn_id)
     VALUES (?, ?, ?, ?)`,
  );
  scheduled.transaction(() => {
    for (let index = 0; index < rowCount; index += 1) {
      insertRun.run(
        `scale-run-${index}`,
        ownerPrincipal,
        `scale-session-${index}`,
        `scale-turn-${index}`,
      );
    }
  })();
  scheduled.close();
  scheduled = null;

  const startedAt = performance.now();
  db.migrate(MIGRATIONS);
  const elapsedMs = performance.now() - startedAt;
  const migrated = db.get(
    `SELECT COUNT(*) AS count
     FROM turn_inputs
     WHERE owner_scope = ? AND migration_status = 'owned'
       AND scheduled_task_run_id IS NOT NULL`,
    ownerScope,
  );
  assert.equal(Number(migrated.count), rowCount);
  assert.ok(
    elapsedMs < 5_000,
    `10k/10k migration must remain linear and bounded, took ${elapsedMs.toFixed(1)}ms`,
  );
  console.log(
    `turn-admission-migration-scale: ok (${rowCount} turns/runs, ${elapsedMs.toFixed(1)}ms)`,
  );
} finally {
  scheduled?.close();
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
