#!/usr/bin/env node
// Scheduler self-heal: silent failures become recorded, visible, terminal
// states — and with LILY_SCHEDULER_SELF_HEAL=0 nothing changes from before.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// The scheduler resolves its legacy-import path through config; point it at
// a throwaway directory so this test can never touch a real store.
process.env.LILY_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-heal-userdata-"));

const require = createRequire(import.meta.url);
const { ScheduledTaskManager } = require("../src/main/scheduled-tasks.js");
const { ScheduledTaskStore } = require("../src/main/store/scheduled-task-store.js");
const { describeNow } = require("../src/main/scheduled-task-ai-draft.js");

const principal = "user:alice";
const sessions = new Map([
  ["origin-a", { id: "origin-a", projectId: "project-a" }],
  ["origin-b", { id: "origin-b", projectId: "project-a" }],
]);
const sent = [];
const durableTurns = new Map();
let busy = false;

function context() {
  return {
    sessionManager: {
      findById: (id) => sessions.get(id) || null,
      pushMessageTo() {},
      findTurnInputByScheduledRun: (_sessionId, runId) => durableTurns.get(runId) || null,
    },
    projectManager: { find: (id) => (id === "project-a" ? { id } : null) },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, _text, _files, opts) => {
        sent.push({ sessionId, opts });
        if (busy) return { ok: true, queued: true, itemId: `q-${sent.length}` };
        return { ok: true, turnId: `turn-${sent.length}` };
      },
    },
  };
}

function fresh(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-heal-"));
  const dbPath = path.join(root, "scheduled-tasks.db");
  const manager = new ScheduledTaskManager({ dbPath, resolvePrincipal: () => principal, maxConcurrentRuns: 2, powerMonitor: null, ...options });
  manager.load();
  manager.start(context());
  manager.stop();
  return { manager, dbPath };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const daily = { type: "daily", hour: 9, minute: 0 };

// 1. A task whose session is gone: one recorded failure, then it pauses itself
//    with the reason. The next tick does nothing — no silent per-minute loop.
{
  const { manager } = fresh();
  const created = manager.create({ title: "orphan", prompt: "整理待办", schedule: daily, sessionId: "origin-a", projectId: "project-a" });
  assert.equal(created.ok, true);
  const task = created.task;
  task.nextRunAt = "2020-01-01T00:00:00.000Z";
  sessions.delete("origin-a");
  await manager.tick();
  const runs = manager.runs.filter((run) => run.taskId === task.id);
  assert.equal(runs.length, 1, "scope failure leaves exactly one run record");
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "SCOPE_MISSING");
  assert.equal(task.enabled, false);
  assert.equal(task.status, "paused");
  assert.equal(task.pausedReason, "SCOPE_MISSING");
  assert.equal(task.nextRunAt, null);
  await manager.tick();
  assert.equal(manager.runs.filter((run) => run.taskId === task.id).length, 1, "a paused task is not retried");
  assert.equal(sent.length, 0, "nothing reached the orchestrator");
  const listed = manager.list().tasks.find((item) => item.id === task.id);
  assert.equal(listed.lastRun.error, "SCOPE_MISSING", "list() exposes the failure for the UI");
  // Re-enabling is refused while the scope is still gone, and says why.
  assert.deepEqual(manager.setEnabled(task.id, true), { ok: false, error: "SCOPE_MISSING" });
  sessions.set("origin-a", { id: "origin-a", projectId: "project-a" });
  const resumed = manager.setEnabled(task.id, true);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.task.pausedReason, null);
  assert.ok(resumed.task.nextRunAt, "a resumed task gets a next run");
  manager.close();
}

// 2. Startup audit: tasks that lost their scope while the app was closed pause
//    at start, before the first tick.
{
  const { manager, dbPath } = fresh();
  manager.create({ title: "will-orphan", prompt: "检查", schedule: daily, sessionId: "origin-b", projectId: "project-a" });
  manager.close();
  sessions.delete("origin-b");
  const again = new ScheduledTaskManager({ dbPath, resolvePrincipal: () => principal, powerMonitor: null });
  again.load();
  again.start(context());
  again.stop();
  const task = again.tasks[0];
  assert.equal(task.enabled, false);
  assert.equal(task.pausedReason, "SCOPE_MISSING");
  again.close();
  sessions.set("origin-b", { id: "origin-b", projectId: "project-a" });
}

// 3. Kill switch: with self-heal off the old behavior stays — no run record,
//    task still enabled (today's silent skip), so the fallback is the baseline.
{
  const { manager } = fresh({ selfHeal: false });
  const created = manager.create({ title: "legacy", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a" });
  created.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  sessions.delete("origin-a");
  await manager.tick();
  assert.equal(manager.runs.length, 0);
  assert.equal(created.task.enabled, true);
  sessions.set("origin-a", { id: "origin-a", projectId: "project-a" });
  manager.close();
}

// 4. One-shot: runs once, then retires as completed; a past one-shot is refused at creation.
{
  const { manager } = fresh();
  const at = new Date(Date.now() + 60_000).toISOString();
  const created = manager.create({ title: "once", prompt: "发一次", schedule: { type: "once", at }, sessionId: "origin-a", projectId: "project-a" });
  assert.equal(created.ok, true);
  const task = created.task;
  task.nextRunAt = new Date(Date.now() - 1000).toISOString(); // it is now due
  await manager.tick();
  await settle();
  const run = manager.runs.find((item) => item.taskId === task.id);
  assert.ok(run, "one-shot ran");
  assert.equal(task.nextRunAt, null, "no next run after a one-shot fires");
  manager.completeRunById(run.id, "turn.completed", {});
  assert.equal(task.enabled, false);
  assert.equal(task.status, "completed");
  assert.equal(task.pausedReason, "once_completed");
  await manager.tick();
  assert.equal(manager.runs.filter((item) => item.taskId === task.id).length, 1, "a completed one-shot never re-runs");
  const past = manager.create({ title: "past", prompt: "x", schedule: { type: "once", at: "2020-01-01T00:00:00.000Z" }, sessionId: "origin-a", projectId: "project-a" });
  assert.deepEqual(past, { ok: false, error: "SCHEDULE_IN_PAST" });
  manager.close();
}

// 5. dispatch_unknown past its lease closes as failed and unblocks the task;
//    a durable turn that did finish wins over the expiry.
{
  const { manager } = fresh({ leaseMs: 1000 });
  const created = manager.create({ title: "unknown", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a" });
  const task = created.task;
  const run = manager._newRun(task, "2026-01-01T00:00:00.000Z", false);
  run.status = "dispatch_unknown";
  run.startedAt = new Date(Date.now() - 5000).toISOString();
  manager.store.insertRun(run);
  manager.runs.push(run);
  assert.deepEqual(manager.remove(task.id), { ok: false, error: "TASK_ACTIVE" }, "blocked while unknown");
  await manager.tick();
  assert.equal(run.status, "failed");
  assert.equal(run.error, "DISPATCH_UNKNOWN_EXPIRED");
  assert.equal(task.lastError, "DISPATCH_UNKNOWN_EXPIRED");
  assert.equal(manager.remove(task.id).ok, true, "task is removable once the run is closed");

  const c2 = manager.create({ title: "unknown-but-done", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a" });
  const run2 = manager._newRun(c2.task, "2026-01-02T00:00:00.000Z", false);
  run2.status = "dispatch_unknown";
  run2.startedAt = new Date(Date.now() - 5000).toISOString();
  manager.store.insertRun(run2);
  manager.runs.push(run2);
  durableTurns.set(run2.id, { status: "completed", turnId: "t-done", terminalAt: Date.now(), terminalType: "turn.completed" });
  await manager.tick();
  assert.equal(run2.status, "succeeded", "the durable turn's real outcome is used, not the expiry");
  manager.close();
}

// 6. Policies are read, not just stored: overlap "skip" drops an occurrence
//    that came due mid-run; missed "skip" drops an occurrence missed by more
//    than two ticks; the defaults keep today's collapse-into-one behavior.
{
  const { manager } = fresh();
  const skip = manager.create({ title: "skip-overlap", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a", overlapPolicy: "skip" });
  assert.equal(skip.task.overlapPolicy, "skip");
  const active = manager._newRun(skip.task, "2026-01-03T00:00:00.000Z", false);
  active.status = "running";
  manager.store.insertRun(active);
  manager.runs.push(active);
  skip.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  await manager.tick();
  assert.ok(Date.parse(skip.task.nextRunAt) > Date.now(), "overlap skip advanced the due occurrence");

  const missed = manager.create({ title: "skip-missed", prompt: "x", schedule: daily, sessionId: "origin-b", projectId: "project-a", missedRunPolicy: "skip" });
  missed.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  const before = sent.length;
  await manager.tick();
  assert.equal(sent.length, before, "missed skip did not run the stale occurrence");
  assert.ok(Date.parse(missed.task.nextRunAt) > Date.now());

  const bogus = manager.create({ title: "bogus-policy", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a", overlapPolicy: "nonsense", missedRunPolicy: 42 });
  assert.equal(bogus.task.overlapPolicy, "queue");
  assert.equal(bogus.task.missedRunPolicy, "run_once_on_launch");
  manager.close();
}

// 7. Capacity: the queue-time check counts runs still being dispatched and
//    never counts the run being admitted, so the two admission points agree.
{
  const { manager } = fresh({ maxConcurrentRuns: 1 });
  const a = manager.create({ title: "a", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a" });
  const b = manager.create({ title: "b", prompt: "x", schedule: daily, sessionId: "origin-b", projectId: "project-a" });
  const ra = manager._newRun(a.task, "2026-01-04T00:00:00.000Z", false);
  manager.store.insertRun(ra); manager.runs.push(ra);
  const rb = manager._newRun(b.task, "2026-01-04T00:00:00.000Z", false);
  manager.store.insertRun(rb); manager.runs.push(rb);
  assert.equal(manager.canStartRun(ra.id), true, "a queued run counts nothing but real load");
  manager._dispatchingRunIds.add(ra.id);
  assert.equal(manager.canStartRun(ra.id), true, "a run never blocks itself while it is being dispatched");
  assert.equal(manager.canStartRun(rb.id), false, "another run mid-dispatch occupies the slot");
  manager._dispatchingRunIds.clear();
  manager.close();
}

// 8. Retention: finished runs beyond 50 per task are pruned at load; active ones never are.
{
  const { manager, dbPath } = fresh();
  const t = manager.create({ title: "history", prompt: "x", schedule: daily, sessionId: "origin-a", projectId: "project-a" });
  for (let i = 0; i < 60; i += 1) {
    // Recent (within retention days) so only the per-task cap applies.
    const run = manager._newRun(t.task, new Date(Date.now() - (i + 1) * 60_000).toISOString(), false);
    run.status = "succeeded"; run.finishedAt = run.scheduledFor;
    manager.store.insertRun(run);
  }
  const ancient = manager._newRun(t.task, "2024-06-01T00:00:00.000Z", false);
  ancient.status = "failed"; ancient.finishedAt = ancient.scheduledFor;
  manager.store.insertRun(ancient);
  const live = manager._newRun(t.task, "2024-01-01T00:00:00.000Z", false);
  live.status = "running";
  manager.store.insertRun(live);
  manager.close();
  const again = new ScheduledTaskManager({ dbPath, resolvePrincipal: () => principal, powerMonitor: null });
  again.load();
  const mine = again.runs.filter((run) => run.taskId === t.task.id);
  assert.equal(mine.filter((run) => run.status === "succeeded").length, 50, "per-task cap keeps the newest 50");
  assert.ok(!mine.some((run) => run.id === ancient.id), "a run older than the retention window is gone");
  assert.ok(mine.some((run) => run.id === live.id), "the active run survived pruning");
  again.close();
}

// 9. Resume hook: a system resume triggers a tick through the injected power monitor.
{
  const listeners = new Map();
  const powerMonitor = { on: (name, fn) => listeners.set(name, fn), removeListener: (name) => listeners.delete(name) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-heal-"));
  const manager = new ScheduledTaskManager({ dbPath: path.join(root, "s.db"), resolvePrincipal: () => principal, powerMonitor });
  manager.load();
  manager.start(context());
  assert.ok(listeners.has("resume"), "scheduler listens for resume while started");
  let ticked = 0;
  manager.tick = async () => { ticked += 1; };
  listeners.get("resume")();
  assert.equal(ticked, 1);
  manager.stop();
  assert.equal(listeners.has("resume"), false, "stop removes the listener");
  manager.close();
}

// 10. Schema v3 round-trips the new columns; the draft model is told the local clock.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-heal-"));
  const store = new ScheduledTaskStore(path.join(root, "s.db"));
  store.saveTask({ id: "t1", ownerPrincipal: principal, projectId: "p", originSessionId: "s", executionSessionId: "s", title: "t", prompt: "p",
    schedule: daily, scheduleText: "d", permissionMode: "inherit", enabled: false, status: "paused", overlapPolicy: "queue", lastRunAt: null,
    nextRunAt: null, missedRunPolicy: "skip", createdAt: "2026-01-01", updatedAt: "2026-01-01", pausedReason: "SCOPE_MISSING", lastError: "SCOPE_MISSING", timezone: "Asia/Shanghai" });
  const loaded = store.load().tasks[0];
  assert.equal(loaded.pausedReason, "SCOPE_MISSING");
  assert.equal(loaded.timezone, "Asia/Shanghai");
  assert.equal(loaded.missedRunPolicy, "skip");
  store.close();
  assert.match(describeNow("2026-09-25T01:00:00.000Z"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}( \(.+\))?$/, "Now carries the local offset");
}

console.log("scheduled-task-self-heal: ok (10 cases)");
