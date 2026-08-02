#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LongTaskStore } = require("../src/main/long-task/store.js");
const { LongTaskSupervisor } = require("../src/main/long-task/supervisor.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-long-task-wakeup-"));
const dbPath = path.join(dir, "long-tasks.db");
const scope = { ownerScope: "owner-a", sessionId: "session-a", projectId: "project-a", turnId: "turn-a" };

function succeededJob(store, id) {
  store.createJob({ id, scope, command: process.execPath, cwd: dir, idempotencyKey: id });
  const lease = store.claimLease(scope, id, { holder: "test", ttlMs: 10_000 });
  return store.markTerminal(scope, id, {
    holder: "test", fencingEpoch: lease.job.fencingEpoch, status: "succeeded", exitCode: 0,
  }).job;
}

function failedJob(store, id) {
  store.createJob({ id, scope, command: process.execPath, cwd: dir, idempotencyKey: id });
  const lease = store.claimLease(scope, id, { holder: "test", ttlMs: 10_000 });
  return store.markTerminal(scope, id, {
    holder: "test", fencingEpoch: lease.job.fencingEpoch, status: "failed", exitCode: 1,
  }).job;
}

let now = 10_000;
const store = new LongTaskStore({ filePath: dbPath, now: () => now });
try {
  const job = succeededJob(store, "job-wake");
  const first = store.enqueueWakeForJob(job.id);
  const duplicate = store.enqueueWakeForJob(job.id);
  assert.equal(first.ok, true);
  assert.equal(duplicate.wake.id, first.wake.id, "one durable wake exists per job");

  let calls = 0;
  const supervisor = new LongTaskSupervisor({
    dbPath,
    jobsDir: path.join(dir, "jobs"),
    holder: "supervisor-a",
    now: () => now,
    onWake: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: "SESSION_BUSY" } : { ok: true };
    },
  });
  const failed = await supervisor.deliverWakesOnce();
  assert.equal(failed.released, 1);
  assert.equal(store.getWake(first.wake.id).status, "pending");
  now += 2_001;
  const delivered = await supervisor.deliverWakesOnce();
  assert.equal(delivered.delivered, 1);
  assert.equal(store.getWake(first.wake.id).status, "delivered");
  await supervisor.deliverWakesOnce();
  assert.equal(calls, 2, "delivered wake is never dispatched twice");

  const failure = failedJob(store, "job-failed");
  assert.equal(store.enqueueWakeForJob(failure.id).ok, true, "failure wakes the originating agent for recovery");
  assert.equal((await supervisor.deliverWakesOnce()).delivered, 1);

  const abandonedJob = succeededJob(store, "job-abandoned");
  const abandonedWake = store.enqueueWakeForJob(abandonedJob.id).wake;
  const permanent = new LongTaskSupervisor({
    dbPath, jobsDir: path.join(dir, "jobs"), holder: "permanent",
    now: () => now,
    onWake: async () => ({ ok: false, permanent: true, error: "OWNER_SCOPE_CHANGED" }),
  });
  assert.equal((await permanent.deliverWakesOnce()).abandoned, 1);
  assert.equal(store.getWake(abandonedWake.id).status, "abandoned");

  const second = succeededJob(store, "job-race");
  store.enqueueWakeForJob(second.id);
  let raceCalls = 0;
  const make = (holder) => new LongTaskSupervisor({
    dbPath, jobsDir: path.join(dir, "jobs"), holder,
    now: () => now,
    onWake: async () => { raceCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true }; },
  });
  await Promise.all([make("race-a").deliverWakesOnce(), make("race-b").deliverWakesOnce()]);
  assert.equal(raceCalls, 1, "lease and fencing permit only one concurrent delivery");
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("long-task-wakeup: ok");
