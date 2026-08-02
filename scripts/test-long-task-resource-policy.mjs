#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureLaunchDiskSpace } = require("../src/main/long-task/disk-policy.js");
const { enforceGlobalLogQuota } = require("../src/main/long-task/log-policy.js");
const { LongTaskStore } = require("../src/main/long-task/store.js");
const { longTaskDiagnosticCheck } = require("../src/main/support-diagnostics.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-long-resource-"));
try {
  assert.equal(ensureLaunchDiskSpace(dir, { statfsSync: () => ({ bavail: 1, bsize: 1024 }), minFreeBytes: 2048 }).error, "INSUFFICIENT_DISK_SPACE");
  assert.equal(ensureLaunchDiskSpace(dir, { statfsSync: () => ({ bavail: 3, bsize: 1024 }), minFreeBytes: 2048 }).ok, true);

  const a = path.join(dir, "a.stdout.log");
  const b = path.join(dir, "b.stderr.log");
  fs.writeFileSync(a, "a".repeat(100));
  fs.writeFileSync(b, "b".repeat(100));
  fs.utimesSync(a, new Date(1), new Date(1));
  const quota = enforceGlobalLogQuota(dir, { maxBytes: 150, retainBytes: 25 });
  assert.equal(quota.trimmedFiles, 1);
  assert(fs.statSync(a).size <= 25, "oldest log is trimmed first");

  let now = 1_000;
  const dbPath = path.join(dir, "long-tasks.db");
  const store = new LongTaskStore({ filePath: dbPath, now: () => now });
  const scope = { ownerScope: "o", sessionId: "s", projectId: "p", turnId: "t" };
  store.createJob({ id: "old", scope, command: "echo", cwd: dir, idempotencyKey: "old" });
  const lease = store.claimLease(scope, "old", { holder: "h", ttlMs: 1000 });
  store.markTerminal(scope, "old", { holder: "h", fencingEpoch: lease.job.fencingEpoch, status: "failed" });
  now += 40 * 24 * 60 * 60_000;
  assert.equal(store.pruneTerminal({ olderThanMs: 30 * 24 * 60 * 60_000 }).prunedJobs.length, 1);
  store.close();

  const diagnostic = longTaskDiagnosticCheck({ dbPath });
  assert.equal(diagnostic.id, "long_task.store");
  assert(!JSON.stringify(diagnostic).includes("scopeToken"));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("long-task-resource-policy: ok");
