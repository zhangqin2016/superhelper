"use strict";

const { ACTIVE_RUN_STATUSES } = require("./store/scheduled-task-store");

const DEFAULT_MAX_CONCURRENT_RUNS = 3;

function hasActiveTaskRun(runs, taskId) {
  return runs.some((run) => run.taskId === taskId && ACTIVE_RUN_STATUSES.has(run.status));
}

function runningRunCount(runs, ownerPrincipal) {
  return runs.filter(
    (run) => run.ownerPrincipal === ownerPrincipal && run.status === "running",
  ).length;
}

function executionLoad(runs, dispatchingRunIds, ownerPrincipal) {
  return runs.filter(
    (run) => run.ownerPrincipal === ownerPrincipal
      && (run.status === "running" || dispatchingRunIds.has(run.id)),
  ).length;
}

function nextRunAfterNow(task, scheduledFor, computeNextRunAt, now = Date.now()) {
  const scheduledAt = Date.parse(scheduledFor || "");
  const anchor = Math.max(now, Number.isFinite(scheduledAt) ? scheduledAt : 0);
  return computeNextRunAt(task.schedule, new Date(anchor + 1000));
}

module.exports = {
  DEFAULT_MAX_CONCURRENT_RUNS,
  executionLoad,
  hasActiveTaskRun,
  nextRunAfterNow,
  runningRunCount,
};
