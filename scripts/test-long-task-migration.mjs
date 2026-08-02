#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { migrateLegacyProcessJobs } = require("../src/main/long-task/legacy-migration.js");
const { LongTaskStore } = require("../src/main/long-task/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-long-migration-"));
try {
  const legacyPath = path.join(dir, "jobs.json");
  const dbPath = path.join(dir, "long-tasks.db");
  fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, jobs: {
    alpha: { jobId: "alpha", command: "echo ok", cwd: dir, status: "exited", exitCode: 0, outputFiles: [path.join(dir, "a.txt")] },
    beta: { jobId: "beta", command: "upload", cwd: dir, status: "running" },
  } }));
  const migrated = migrateLegacyProcessJobs({ legacyPath, dbPath });
  assert.equal(migrated.imported, 2);
  assert.equal(migrateLegacyProcessJobs({ legacyPath, dbPath }).alreadyMigrated, true);
  const store = new LongTaskStore({ filePath: dbPath });
  assert.equal(store.listJobsByStatus("succeeded").length, 1);
  assert.equal(store.listJobsByStatus("outcome_unknown").length, 1, "active legacy writes are never replayed");
  assert.equal(store.listPendingWakes().length, 0, "unscoped legacy jobs never wake a conversation");
  store.close();

  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{broken");
  const bad = migrateLegacyProcessJobs({ legacyPath: corrupt, dbPath: path.join(dir, "bad.db") });
  assert.equal(bad.error, "LEGACY_REGISTRY_CORRUPT");
  assert.equal(fs.readFileSync(corrupt, "utf8"), "{broken", "corrupt source is preserved for support recovery");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("long-task-migration: ok");
