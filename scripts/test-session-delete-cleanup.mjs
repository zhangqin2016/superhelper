#!/usr/bin/env node
// Deleting a conversation is a task boundary: pending continuations are
// fenced and the session's durable process jobs are stopped and marked
// cancelled with the reason, so no orphaned worker keeps burning CPU and no
// wake is dropped silently. Other sessions' jobs are untouched; failures are
// reported, never thrown. [gate: task-completion-integrity]
// Run: node scripts/test-session-delete-cleanup.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LongTaskStore } = require("../src/main/long-task/store.js");
const { stopJobsForSession } = require("../src/main/long-task/session-cleanup.js");
const { fenceSessionWork } = require("../src/main/session-delete-cleanup.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-delete-cleanup-"));
const dbPath = path.join(tmp, "long-tasks.db");
const OWNER = "profile:account:owner-a";
const scope = { ownerScope: OWNER, sessionId: "s-doomed", projectId: "p1", turnId: "t1" };
const otherScope = { ownerScope: OWNER, sessionId: "s-alive", projectId: "p1", turnId: "t2" };

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

try {
  const store = new LongTaskStore({ filePath: dbPath });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const created = store.createJob({ scope, id: "job-doomed", command: "node", args: [], cwd: tmp, idempotencyKey: "k1" });
  const other = store.createJob({ scope: otherScope, id: "job-alive", command: "node", args: [], cwd: tmp, idempotencyKey: "k2" });
  assert.ok(created?.id === "job-doomed" && other?.id === "job-alive", "fixture jobs created");
  // Fixture shortcut: the real launcher attaches the pid; here we pin the
  // sleeper processes directly so the cleanup has something to stop.
  for (const [id, pid] of [["job-doomed", sleeper.pid], ["job-alive", bystander.pid]]) {
    store.db.run("UPDATE long_task_jobs SET status='running', pid=? WHERE id=?", pid, id);
  }
  store.close();

  await check("stopJobsForSession stops and cancels only the deleted session's active jobs", async () => {
    const result = await stopJobsForSession({ dbPath, ownerScope: OWNER, sessionId: "s-doomed", projectId: "p1", graceMs: 1500 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stopped, ["job-doomed"]);
    assert.equal(result.failed.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(sleeper.pid), false, "the doomed worker is gone");
    assert.equal(alive(bystander.pid), true, "the other session's worker keeps running");
    const reopened = new LongTaskStore({ filePath: dbPath });
    const doomed = reopened.getJob(scope, "job-doomed");
    assert.equal(doomed.status, "cancelled");
    assert.match(String(doomed.error || ""), /SESSION_DELETED/);
    assert.equal(reopened.getJob(otherScope, "job-alive").status, "running");
    reopened.close();
  });

  await check("fenceSessionWork cancels continuations through the recovery runtime and reports job counts", async () => {
    const cancelled = [];
    const ctx = {
      turnOrchestrator: { turnRecoveryRuntime: { cancelPendingParentClosures: (sid) => cancelled.push(sid) } },
      sessionManager: { resolveTurnOwnerScope: () => ({ ok: true, ownerScope: OWNER }) },
    };
    const summary = await fenceSessionWork(ctx, { id: "s-alive", projectId: "p1" }, { dbPath, graceMs: 1500 });
    assert.deepEqual(cancelled, ["s-alive"]);
    assert.equal(summary.continuationsCancelled, true);
    assert.deepEqual(summary.jobs.stopped, ["job-alive"]);
    assert.equal(summary.errors.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(bystander.pid), false);
  });

  await check("fail-open: missing session, missing owner scope, or a broken runtime never throw", async () => {
    assert.deepEqual((await fenceSessionWork({}, null)).sessionId, "");
    const noOwner = await fenceSessionWork({ sessionManager: { resolveTurnOwnerScope: () => ({ ok: false }) } }, { id: "x" }, { dbPath });
    assert.equal(noOwner.jobs.total, 0);
    const broken = await fenceSessionWork({ turnOrchestrator: { turnRecoveryRuntime: { cancelPendingParentClosures: () => { throw new Error("boom"); } } }, sessionManager: { resolveTurnOwnerScope: () => ({ ok: true, ownerScope: OWNER }) } }, { id: "s-none", projectId: "p1" }, { dbPath });
    assert.equal(broken.continuationsCancelled, false);
    assert.match(broken.errors[0], /boom/);
    assert.equal(broken.jobs.total, 0);
  });

  await check("the session:delete IPC awaits the fence before terminating the runner", async () => {
    const src = fs.readFileSync(new URL("../src/main/ipc-sessions.js", import.meta.url), "utf8");
    const handler = src.slice(src.indexOf('ipcMain.handle("session:delete"'), src.indexOf('ipcMain.handle("session:archive"'));
    assert.match(handler, /async \(_event, sessionId\)/);
    assert.ok(handler.indexOf("fenceSessionWork") < handler.indexOf("runnerPool.terminateSession"), "fence runs before the runner is torn down");
    assert.match(handler, /stoppedJobs/);
  });

  console.log(`\n${checks} checks passed (session delete cleanup)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
