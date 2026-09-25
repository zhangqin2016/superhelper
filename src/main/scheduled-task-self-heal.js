"use strict";

/**
 * Scheduler self-heal: the parts that turn a silent failure into a recorded,
 * visible, terminal state. All entry points take the ScheduledTaskManager and
 * are only called when `manager.selfHeal` is on.
 */
const crypto = require("node:crypto");
const { reconcileScheduledRunsWithDurableTurns } = require("./scheduled-task-dispatch");
const { turnFailure } = require("./turn-failure");
const { nowIso } = require("./schedule-parser");
const { getLogger } = require("./logger");

const log = getLogger("scheduler");

/** A run whose outcome never resolved past its lease is closed as failed, after
 *  the durable turn is consulted once more. Two shapes qualify: a run marked
 *  `dispatch_unknown` (the orchestrator could not say), and a run left
 *  `promoted` by a previous process — the engine had taken it when the app
 *  died, so no terminal event can ever arrive for it. A `promoted` run owned
 *  by this process belongs to a live turn and is left alone however long it runs. */
function expireUnknownRuns(manager) {
  if (!manager.ctx) return;
  const now = Date.now();
  for (const run of manager.runs) {
    const orphanedPromotion = run.status === "promoted" && run.leaseOwner !== manager._leaseOwner;
    if (run.status !== "dispatch_unknown" && !orphanedPromotion) continue;
    const since = Date.parse(run.startedAt || run.engineAcceptedAt || run.queuedAt || "") || 0;
    if (!since || now - since < manager.leaseMs) continue;
    const before = run.status;
    reconcileScheduledRunsWithDurableTurns(manager.ctx, [run], manager.tasks, manager.store, manager._principal());
    if (run.status !== before) continue;
    log.warn("run %s (task %s) %s for %d min with no outcome; closing as failed",
      run.id, run.taskId, before, Math.round((now - since) / 60_000));
    manager._finishRun(run, "turn.failed", turnFailure({ code: "DISPATCH_UNKNOWN_EXPIRED", retryable: false }));
  }
}

const SCOPE_REASONS = new Set(["SCOPE_MISSING", "SCOPE_MISMATCH"]);

/** Self-heal runs both ways: a task that paused because its session or
 *  workspace was missing resumes by itself once they are back (a session
 *  index that failed to load at boot and was recovered later, for example). */
function resumeRecoveredScopes(manager) {
  if (!manager.ctx) return;
  const owner = manager._principal();
  for (const task of manager.tasks) {
    if (task.ownerPrincipal !== owner || task.enabled || !SCOPE_REASONS.has(task.pausedReason)) continue;
    if (manager._validateScope(task.originSessionId, task.projectId)) continue;
    const nextRunAt = manager.computeNextRunAt(task.schedule);
    if (!nextRunAt) continue;
    task.enabled = true;
    task.status = "scheduled";
    task.nextRunAt = nextRunAt;
    task.pausedReason = null;
    task.updatedAt = nowIso();
    manager.store?.saveTask(task);
    log.info("task %s resumed: its session and workspace are back", task.id);
  }
}

/** At start, every enabled task must still point at a live session in a
 *  live workspace; the ones that do not pause themselves and say why. */
function auditScopes(manager) {
  const owner = manager._principal();
  for (const task of manager.tasks) {
    if (task.ownerPrincipal !== owner || !task.enabled) continue;
    const scopeError = manager._validateScope(task.originSessionId, task.projectId);
    if (scopeError) pauseTask(manager, task, scopeError);
  }
}

function pauseTask(manager, task, reason) {
  task.enabled = false;
  task.status = "paused";
  task.nextRunAt = null;
  task.pausedReason = reason;
  task.lastError = reason;
  task.updatedAt = nowIso();
  manager.store?.saveTask(task);
  log.warn("task %s paused: %s", task.id, reason);
}

function retireTask(manager, task, reason) {
  task.enabled = false;
  task.status = "completed";
  task.nextRunAt = null;
  task.pausedReason = reason;
  task.updatedAt = nowIso();
  manager.store?.saveTask(task);
  log.info("task %s completed (%s)", task.id, reason);
}

/** The session or workspace behind the task is gone. Leave a failed run so
 *  the list shows what happened, and pause the task so this is the last time. */
function recordScopeFailure(manager, task, scopeError, opts = {}) {
  const scheduledFor = opts.manual
    ? `manual:${nowIso()}:${crypto.randomUUID()}`
    : opts.scheduledFor || task.nextRunAt || nowIso();
  const run = manager._newRun(task, scheduledFor, Boolean(opts.manual));
  run.status = "failed";
  run.finishedAt = nowIso();
  run.leaseExpiresAt = null;
  run.error = scopeError;
  if (manager.store?.insertRun(run)) manager.runs.push(run);
  task.lastRunAt = run.finishedAt;
  pauseTask(manager, task, scopeError);
}

module.exports = { auditScopes, expireUnknownRuns, pauseTask, recordScopeFailure, resumeRecoveredScopes, retireTask };
