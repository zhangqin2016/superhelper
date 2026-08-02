#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LongTaskStore } = require("../src/main/long-task/store.js");
const { LongTaskSupervisor } = require("../src/main/long-task/supervisor.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-long-task-recovery-"));
const dbPath = path.join(dir, "long-tasks.db");
const jobsDir = path.join(dir, "jobs");
fs.mkdirSync(jobsDir);
const scope = { ownerScope: "owner-a", sessionId: "session-a", projectId: "project-a", turnId: "turn-a" };
let now = 1_000;
const store = new LongTaskStore({ filePath: dbPath, now: () => now });

function running(id, identity) {
  store.createJob({ id, scope, command: process.execPath, cwd: dir, idempotencyKey: id });
  const lease = store.claimLease(scope, id, { holder: "starter", ttlMs: 1_000 });
  return store.attachProcess(scope, id, {
    holder: "starter", fencingEpoch: lease.job.fencingEpoch, pid: identity.pid,
    processIdentity: identity,
    stdoutPath: path.join(jobsDir, `${id}.stdout.log`),
    stderrPath: path.join(jobsDir, `${id}.stderr.log`),
  }).job;
}

try {
  running("alive", { pid: 1001, fingerprint: "strong", launchNonce: "alive", reconnectSafe: true });
  running("finished", { pid: 1002, fingerprint: "strong", launchNonce: "done", reconnectSafe: true });
  running("missing", { pid: 1003, fingerprint: "strong", launchNonce: "missing", reconnectSafe: true });
  const heartbeatPath = path.join(jobsDir, "weak.heartbeat.json");
  running("weak", { pid: 1004, fingerprint: "weak:test", launchNonce: "weak", reconnectSafe: false, heartbeatPath });
  fs.writeFileSync(heartbeatPath, JSON.stringify({ launchNonce: "weak", observedAt: now + 2_000 }));
  fs.writeFileSync(path.join(jobsDir, "finished.terminal.json"), JSON.stringify({ launchNonce: "done", exitCode: 0 }));
  now += 2_000;

  const supervisor = new LongTaskSupervisor({
    dbPath, jobsDir, holder: "recovery", leaseMs: 10_000,
    now: () => now,
    matchesIdentity: (identity) => identity.pid === 1001,
    onWake: async () => ({ ok: true }),
  });
  const result = await supervisor.reconcileOnce();
  assert.equal(result.succeeded, 1);
  assert.equal(result.outcomeUnknown, 1);
  assert.equal(store.getJob(scope, "alive").status, "running");
  assert.equal(store.getJob(scope, "finished").status, "succeeded");
  assert.equal(store.getJob(scope, "missing").status, "outcome_unknown");
  assert.equal(store.getJob(scope, "weak").status, "running", "nonce heartbeat safely reconnects weak identities");
  assert.equal(store.listPendingWakes().length, 2, "success and unknown outcomes each schedule one continuation");
  await supervisor.handleResume();
  assert.equal(store.listPendingWakes().length, 0, "resume reconciles and delivers the durable continuation");
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("long-task-recovery: ok");
