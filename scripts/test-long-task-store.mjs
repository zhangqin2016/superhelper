#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LongTaskStore } = require("../src/main/long-task/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-long-task-store-"));
const file = path.join(dir, "long-tasks.db");
let now = 10_000;
const clock = () => now;
const scopeA = { ownerScope: "owner-a", sessionId: "session-a", projectId: "project-a", turnId: "turn-a" };
const scopeB = { ownerScope: "owner-b", sessionId: "session-b", projectId: "project-b", turnId: "turn-b" };

const a = new LongTaskStore({ filePath: file, now: clock });
const b = new LongTaskStore({ filePath: file, now: clock });

try {
  const created = a.createJob({
    id: "job-a",
    scope: scopeA,
    command: process.execPath,
    args: ["-v"],
    cwd: dir,
    replayPolicy: "idempotent",
    idempotencyKey: "turn-a:job-a",
  });
  assert.equal(created.status, "starting");
  assert.equal(created.version, 1);
  assert.equal(b.getJob(scopeA, "job-a")?.id, "job-a", "second connection reads committed row");
  assert.equal(b.getJob(scopeB, "job-a"), null, "foreign scope cannot observe job existence");
  assert.deepEqual(b.listJobs(scopeB), [], "foreign list is empty");

  assert.throws(() => b.createJob({
    id: "job-a",
    scope: scopeB,
    command: process.execPath,
    cwd: dir,
    idempotencyKey: "turn-b:job-a",
  }), /JOB_ID_CONFLICT/);

  const lease1 = a.claimLease(scopeA, "job-a", { holder: "supervisor-a", ttlMs: 5_000 });
  assert.equal(lease1.ok, true);
  assert.equal(lease1.job.fencingEpoch, 1);
  assert.equal(b.claimLease(scopeA, "job-a", { holder: "supervisor-b", ttlMs: 5_000 }).error, "LEASE_HELD");

  now += 5_001;
  const lease2 = b.claimLease(scopeA, "job-a", { holder: "supervisor-b", ttlMs: 5_000 });
  assert.equal(lease2.ok, true);
  assert.equal(lease2.job.fencingEpoch, 2, "takeover increments fencing epoch");

  const stale = a.recordProgress(scopeA, "job-a", {
    holder: "supervisor-a",
    fencingEpoch: 1,
    progressSeq: 1,
    progress: { phase: "old" },
  });
  assert.equal(stale.error, "FENCE_REJECTED");

  const progressed = b.recordProgress(scopeA, "job-a", {
    holder: "supervisor-b",
    fencingEpoch: 2,
    progressSeq: 1,
    progress: { phase: "render", current: 4, total: 10 },
  });
  assert.equal(progressed.ok, true);
  assert.equal(progressed.job.lastProgressAt, now);
  assert.equal(progressed.job.progress.phase, "render");
  assert.equal(b.recordProgress(scopeA, "job-a", {
    holder: "supervisor-b",
    fencingEpoch: 2,
    progressSeq: 1,
    progress: { phase: "duplicate" },
  }).error, "STALE_PROGRESS");

  const terminal = b.markTerminal(scopeA, "job-a", {
    holder: "supervisor-b",
    fencingEpoch: 2,
    status: "succeeded",
    exitCode: 0,
    outputFiles: [path.join(dir, "result.txt")],
  });
  assert.equal(terminal.ok, true);
  assert.equal(terminal.job.status, "succeeded");
  assert.equal(b.markTerminal(scopeA, "job-a", {
    holder: "supervisor-b", fencingEpoch: 2, status: "failed", exitCode: 1,
  }).error, "TERMINAL_IMMUTABLE");

  const duplicate = a.createJob({
    id: "different-id",
    scope: scopeA,
    command: process.execPath,
    cwd: dir,
    idempotencyKey: "turn-a:job-a",
  });
  assert.equal(duplicate.id, "job-a", "idempotency key returns original durable job");
} finally {
  a.close();
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("long-task-store: ok");
