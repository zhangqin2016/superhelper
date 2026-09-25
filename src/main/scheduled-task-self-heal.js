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

/** A run whose dispatch outcome never resolved past its lease is closed as
 *  failed. Before closing, the durable turn is consulted once more. */
function expireUnknownRuns(manager) {
  const now = Date.now();
  for (const run of manager.runs) {
    if (run.status !== "dispatch_unknown") continue;
    const since = Date.parse(run.startedAt || run.queuedAt || "") || 0;
    if (!since || now - since < manager.leaseMs) continue;
    reconcileScheduledRunsWithDurableTurns(manager.ctx, [run], manager.tasks, manager.store, manager._principal());
    if (run.status !== "dispatch_unknown") continue;
    log.warn("run %s (task %s) dispatch outcome unknown for %d min; closing as failed",
      run.id, run.taskId, Math.round((now - since) / 60_000));
    manager._finishRun(run, "turn.failed", turnFailure({ code: "DISPATCH_UNKNOWN_EXPIRED", retryable: false }));
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

module.exports = { auditScopes, expireUnknownRuns, pauseTask, recordScopeFailure, retireTask };
