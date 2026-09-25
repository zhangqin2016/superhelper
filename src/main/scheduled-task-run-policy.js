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

// Stored on every task since the first schema. "queue" (default) lets an
// overdue occurrence wait for the active run to finish; "skip" drops it.
const OVERLAP_POLICIES = new Set(["queue", "skip"]);
// "run_once_on_launch" (default) collapses everything missed into one run;
// "skip" drops occurrences missed by more than `missedAfterMs`.
const MISSED_RUN_POLICIES = new Set(["run_once_on_launch", "skip"]);

function normalizeOverlapPolicy(value) {
  return OVERLAP_POLICIES.has(value) ? value : "queue";
}

function normalizeMissedRunPolicy(value) {
  return MISSED_RUN_POLICIES.has(value) ? value : "run_once_on_launch";
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
  normalizeMissedRunPolicy,
  normalizeOverlapPolicy,
  runningRunCount,
};
