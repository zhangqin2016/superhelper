"use strict";

const crypto = require("node:crypto");
const { scheduledTasksPath, scheduledTasksDbPath } = require("./config");
const { ownerScopeFromPrincipal, resolveCurrentPrincipal } = require("./character-worlds/owner-scope");
const { ScheduledTaskStore, ACTIVE_RUN_STATUSES } = require("./store/scheduled-task-store");
const { interruptForeignScheduledRun, reconcileScheduledRunsWithDurableTurns } = require("./scheduled-task-dispatch");
const {
  DEFAULT_MAX_CONCURRENT_RUNS,
  executionLoad,
  hasActiveTaskRun,
  nextRunAfterNow,
  normalizeMissedRunPolicy,
  normalizeOverlapPolicy,
} = require("./scheduled-task-run-policy");
const { getLogger } = require("./logger");
const { auditScopes, expireUnknownRuns, pauseTask, recordScopeFailure, resumeRecoveredScopes, retireTask } = require("./scheduled-task-self-heal");
const { dispatchRecoveredQueuedRuns, dispatchRun, finishRun, markRunStarted, newRun } = require("./scheduled-task-run-lifecycle");
const {
  hasScheduledTaskNegation,
  buildTaskPrompt,
  computeNextRunAt,
  describeSchedule,
  normalizeScheduleSpec,
  parseScheduleFromText,
  sanitizeScheduledTaskPrompt,
  nowIso,
  safeText,
  TICK_MS,
  DEFAULT_PERMISSION_MODE,
} = require("./schedule-parser");
const { parseDraft, parseDraftSmart } = require("./scheduled-task-draft");
const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const RUN_HISTORY_KEEP_PER_TASK = 50;
const RUN_HISTORY_KEEP_DAYS = 90;
// "Missed" means the occurrence is older than two ticks: a normal late tick is
// not a miss, a laptop lid closed over the slot is.
const MISSED_AFTER_MS = 2 * TICK_MS;
const defaultPrincipal = () => resolveCurrentPrincipal();
const log = getLogger("scheduler");

// A one-shot that already ran is "completed"; one that cannot run is "exhausted".
function exhaustedReason(task) {
  return task.schedule?.type === "once" && task.lastRunAt ? "once_completed" : "schedule_exhausted";
}

function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

// Self-heal (default on): a task whose workspace or session is gone pauses
// itself with a reason instead of failing silently every minute; a one-shot
// retires after it runs; a run whose dispatch outcome stays unknown past its
// lease is closed as failed so the task is not blocked forever. Off = today's
// behavior, nothing else changes.
function selfHealEnabled(options = {}) {
  if (typeof options.selfHeal === "boolean") return options.selfHeal;
  return String(process.env.LILY_SCHEDULER_SELF_HEAL || "").trim() !== "0";
}

class ScheduledTaskManager {
  constructor(options = {}) {
    this.options = options;
    this.tasks = [];
    this.runs = [];
    this.ctx = null;
    this._timer = null;
    this._startupTimer = null;
    this._recoveredQueuedRunIds = new Set();
    this._dispatchingRunIds = new Set();
    this._leaseOwner = `scheduler_${crypto.randomUUID()}`;
    this._resolvePrincipal = options.resolvePrincipal || defaultPrincipal;
    this.maxConcurrentRuns = Math.max(1, Number(options.maxConcurrentRuns) || DEFAULT_MAX_CONCURRENT_RUNS);
    this.leaseMs = Math.max(1000, Number(options.leaseMs) || DEFAULT_LEASE_MS);
    this.selfHeal = selfHealEnabled(options);
    this.store = null;
    this._onResume = () => {
      log.info("system resumed; checking for due tasks");
      void this.tick({ resume: true });
    };
  }
  load() {
    this.store ||= new ScheduledTaskStore(this.options.dbPath || scheduledTasksDbPath());
    const principal = this._principal();
    const migration = principal
      ? this.store.importLegacy(
          this.options.legacyPath || scheduledTasksPath(),
          (task) => this._normalizeTask(task),
          principal,
        )
      : { ok: false, error: "OWNER_SCOPE_UNAVAILABLE", imported: 0 };
    const recovered = this.store.recoverExpired(
      nowIso(),
      this._leaseOwner,
      new Date(Date.now() + this.leaseMs).toISOString(),
    );
    if (this.selfHeal) {
      try {
        const cutoff = new Date(Date.now() - RUN_HISTORY_KEEP_DAYS * 86_400_000).toISOString();
        const pruned = this.store.pruneTerminalRuns({ keepPerTask: RUN_HISTORY_KEEP_PER_TASK, olderThanIso: cutoff });
        if (pruned) log.info("pruned %d finished run records", pruned);
      } catch (error) {
        log.warn("run history prune skipped: %s", error?.message || error);
      }
    }
    const loaded = this.store.load();
    this.tasks = loaded.tasks.map((task) => this._normalizeTask(task)).filter(Boolean);
    for (const task of this.tasks) this.store.saveTask(task);
    this.runs = loaded.runs;
    this._recoveredQueuedRunIds = new Set(
      recovered.filter((run) => run.recoveredFromStatus === "queued").map((run) => run.id),
    );
    if (recovered.length) this._reconcileTaskStates(recovered);
    return migration;
  }
  start(ctx) {
    this.ctx = ctx;
    this.stop();
    reconcileScheduledRunsWithDurableTurns(this.ctx, this.runs, this.tasks, this.store, this._principal());
    if (this.selfHeal) this._auditScopes();
    this._timer = setInterval(() => void this.tick(), TICK_MS);
    this._timer.unref?.();
    this._powerMonitor = this._resolvePowerMonitor();
    this._powerMonitor?.on?.("resume", this._onResume);
    this._dispatchRecoveredQueuedRuns();
    this._startupTimer = setTimeout(() => void this.tick({ startup: true }), 1200);
    this._startupTimer.unref?.();
    const owner = this._principal();
    const mine = this.tasks.filter((task) => task.ownerPrincipal === owner);
    log.info("started: %d tasks (%d enabled), %d run records, self-heal %s",
      mine.length, mine.filter((task) => task.enabled).length, this.runs.length, this.selfHeal ? "on" : "off");
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._startupTimer) clearTimeout(this._startupTimer);
    this._timer = null;
    this._startupTimer = null;
    this._powerMonitor?.removeListener?.("resume", this._onResume);
    this._powerMonitor = null;
  }
  _resolvePowerMonitor() {
    if (this.options.powerMonitor !== undefined) return this.options.powerMonitor || null;
    try { return require("electron").powerMonitor || null; } catch { return null; }
  }
  close() { this.stop(); this.store?.close(); this.store = null; }
  save() {
    if (!this.store) return;
    for (const task of this.tasks) this.store.saveTask(task);
    for (const run of this.runs) this.store.saveRun(run);
  }

  parseDraft(input) { return parseDraft(input); }
  async parseDraftSmart(input) { return parseDraftSmart(this, input); }

  create(payload = {}) {
    const rawPrompt = safeText(payload.prompt, 4000);
    const prompt = sanitizeScheduledTaskPrompt(rawPrompt);
    const title = safeText(sanitizeScheduledTaskPrompt(payload.title), 80) || prompt.slice(0, 48) || "Scheduled Task";
    const normalizedSchedule = normalizeScheduleSpec(payload.schedule);
    const parsed = normalizedSchedule
      ? { ok: true, schedule: normalizedSchedule, scheduleText: describeSchedule(normalizedSchedule), nextRunAt: computeNextRunAt(normalizedSchedule) }
      : parseScheduleFromText(payload.scheduleText || rawPrompt || prompt);
    if (!prompt) return { ok: false, error: "EMPTY" };
    if (!payload.sessionId || !payload.projectId) return { ok: false, error: "MISSING_SCOPE" };
    if (parsed.ok && parsed.schedule?.type === "once" && !parsed.nextRunAt) return { ok: false, error: "SCHEDULE_IN_PAST" };
    if (!parsed.ok || !parsed.nextRunAt) return { ok: false, error: parsed.error || "INVALID_SCHEDULE" };
    const ownerPrincipal = this._principal();
    if (!ownerPrincipal) return { ok: false, error: "OWNER_SCOPE_UNAVAILABLE" };
    const scopeError = this._validateScope(payload.sessionId, payload.projectId);
    if (scopeError) return { ok: false, error: scopeError };
    const now = nowIso();
    const id = `sched_${crypto.randomUUID()}`;
    const task = this._normalizeTask({
      id,
      ownerPrincipal,
      projectId: payload.projectId,
      originSessionId: payload.sessionId,
      executionSessionId: payload.sessionId,
      title,
      prompt,
      schedule: parsed.schedule,
      scheduleText: payload.scheduleText || parsed.scheduleText,
      permissionMode: DEFAULT_PERMISSION_MODE,
      enabled: payload.enabled !== false,
      status: payload.enabled === false ? "paused" : "scheduled",
      overlapPolicy: normalizeOverlapPolicy(payload.overlapPolicy),
      lastRunAt: null,
      nextRunAt: payload.enabled === false ? null : parsed.nextRunAt,
      missedRunPolicy: normalizeMissedRunPolicy(payload.missedRunPolicy),
      pausedReason: null,
      lastError: null,
      timezone: localTimezone(),
      createdAt: now,
      updatedAt: now,
    });
    this.tasks.push(task);
    this.store?.saveTask(task);
    log.info("task created %s (%s) next %s", task.id, task.scheduleText, task.nextRunAt || "-");
    return { ok: true, task };
  }

  importPausedTemplates(templates, scope = {}) {
    const { normalizeTaskTemplates } = require("./scheduled-task-portability");
    const normalized = normalizeTaskTemplates(templates);
    const tasks = [];
    for (const template of normalized.templates) {
      const result = this.create({ ...template, ...scope, enabled: false });
      if (result.ok) tasks.push(result.task);
    }
    const skippedTemplates = Array.isArray(normalized.skipped) ? normalized.skipped.length : Number(normalized.skipped) || 0;
    return { ok: true, tasks, skipped: skippedTemplates + (normalized.templates.length - tasks.length) };
  }

  list(filter = {}) {
    const owner = this._principal();
    const sessionId = filter.sessionId ? String(filter.sessionId) : "";
    const projectId = filter.projectId ? String(filter.projectId) : "";
    return {
      ok: true,
      tasks: this.tasks
        .filter((task) => task.ownerPrincipal === owner)
        .filter((task) => !sessionId || task.originSessionId === sessionId)
        .filter((task) => !projectId || task.projectId === projectId)
        .map((task) => ({ ...task, lastRun: this.runs.filter((run) => run.taskId === task.id).at(-1) || null })),
    };
  }

  setEnabled(taskId, enabled, scope = {}) {
    const task = this._findOwnedTask(taskId, scope);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    if (enabled && this.selfHeal) {
      const scopeError = this._validateScope(task.originSessionId, task.projectId);
      if (scopeError) return { ok: false, error: scopeError };
      if (!task.nextRunAt && !computeNextRunAt(task.schedule)) return { ok: false, error: "SCHEDULE_EXHAUSTED" };
    }
    task.enabled = Boolean(enabled);
    task.updatedAt = nowIso();
    if (!task.enabled) {
      if (!hasActiveTaskRun(this.runs, task.id)) task.status = "paused";
      task.nextRunAt = null;
      task.pausedReason = "user";
    } else {
      task.status = hasActiveTaskRun(this.runs, task.id) ? task.status : "scheduled";
      task.nextRunAt ||= computeNextRunAt(task.schedule);
      task.pausedReason = null;
    }
    this.store?.saveTask(task);
    return { ok: true, task };
  }

  remove(taskId, scope = {}) {
    const task = this._findOwnedTask(taskId, scope);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    if (hasActiveTaskRun(this.runs, task.id)) return { ok: false, error: "TASK_ACTIVE" };
    this.tasks = this.tasks.filter((item) => item.id !== task.id);
    this.runs = this.runs.filter((run) => run.taskId !== task.id);
    this.store?.deleteTask(task.id);
    return { ok: true };
  }

  runNow(taskId, scope = {}) {
    const task = this._findOwnedTask(taskId, scope);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    return this._runTask(task, { manual: true });
  }

  computeNextRunAt(schedule, from) { return computeNextRunAt(schedule, from); }

  async tick() {
    if (this.selfHeal) {
      this._expireUnknownRuns();
      resumeRecoveredScopes(this);
    }
    this._dispatchRecoveredQueuedRuns();
    const owner = this._principal();
    let available = this.maxConcurrentRuns - executionLoad(this.runs, this._dispatchingRunIds, owner);
    if (available <= 0) return;
    const now = Date.now();
    for (const task of this.tasks) {
      if (available <= 0) break;
      if (task.ownerPrincipal !== owner || !task.enabled) continue;
      if (hasActiveTaskRun(this.runs, task.id)) {
        // "skip" drops an occurrence that came due while the previous run is
        // still going; "queue" (default) leaves it due so it runs right after.
        if (this.selfHeal && task.overlapPolicy === "skip" && task.nextRunAt && Date.parse(task.nextRunAt) <= now) {
          task.nextRunAt = nextRunAfterNow(task, task.nextRunAt, computeNextRunAt, now);
          this.store?.saveTask(task);
        }
        continue;
      }
      if (!task.nextRunAt) {
        task.nextRunAt = computeNextRunAt(task.schedule);
        if (!task.nextRunAt && this.selfHeal) { this._retireTask(task, exhaustedReason(task)); continue; }
        this.store?.saveTask(task);
        continue;
      }
      const dueAt = Date.parse(task.nextRunAt);
      if (dueAt > now) continue;
      if (this.selfHeal && task.missedRunPolicy === "skip" && now - dueAt > MISSED_AFTER_MS) {
        const next = nextRunAfterNow(task, task.nextRunAt, computeNextRunAt, now);
        log.info("task %s missed %s; policy skip → next %s", task.id, task.nextRunAt, next || "-");
        task.nextRunAt = next;
        if (!next) { this._retireTask(task, exhaustedReason(task)); continue; }
        this.store?.saveTask(task);
        continue;
      }
      const result = this._runTask(task, { scheduled: true, scheduledFor: task.nextRunAt });
      if (result.ok) available -= 1;
    }
  }

  handlePrincipalChange() {
    const current = this._principal();
    if (!current) return { ok: false, error: "OWNER_SCOPE_UNAVAILABLE" };
    for (const run of this.runs) {
      if (!ACTIVE_RUN_STATUSES.has(run.status) || run.ownerPrincipal === current) continue;
      interruptForeignScheduledRun(this.ctx, run);
    }
    void this.tick();
    return { ok: true };
  }

  completeRunById(runId, terminalType, payload = {}) {
    const run = this.runs.find((item) => item.id === runId && ACTIVE_RUN_STATUSES.has(item.status));
    if (!run) return false;
    this._finishRun(run, terminalType, payload);
    return true;
  }

  completeRun(sessionId, turnId, terminalType, payload = {}) {
    const run = [...this.runs].reverse().find(
      (item) => item.sessionId === sessionId && item.turnId === turnId && ACTIVE_RUN_STATUSES.has(item.status),
    );
    return run ? this.completeRunById(run.id, terminalType, payload) : false;
  }

  completeQueuedRun(runId, terminalType, payload = {}) {
    const run = this.runs.find((item) => item.id === runId && item.status === "queued");
    return run ? this.completeRunById(run.id, terminalType, payload) : false;
  }
  markRunStarted(runId, turnId, dispatchAttemptId = null, dispatchStartedAt = null) {
    return markRunStarted(this, runId, turnId, dispatchAttemptId, dispatchStartedAt);
  }
  _dispatchRun(task, run, opts = {}) { dispatchRun(this, task, run, opts); }
  _dispatchRecoveredQueuedRuns() { dispatchRecoveredQueuedRuns(this); }
  _finishRun(run, terminalType, payload = {}) { finishRun(this, run, terminalType, payload); }
  _newRun(task, scheduledFor, manual) { return newRun(this, task, scheduledFor, manual); }
  _expireUnknownRuns() { expireUnknownRuns(this); }
  _auditScopes() { auditScopes(this); }
  _pauseTask(task, reason) { pauseTask(this, task, reason); }
  _retireTask(task, reason) { retireTask(this, task, reason); }
  _recordScopeFailure(task, scopeError, opts) { recordScopeFailure(this, task, scopeError, opts); }

  canStartRun(runId) {
    const run = this.runs.find((item) => item.id === runId && ACTIVE_RUN_STATUSES.has(item.status));
    if (!run) return false;
    if (run.status === "running") return true;
    // Same load the tick uses (running + mid-dispatch), minus this run itself,
    // so the two admission points cannot disagree and retry against each other.
    const others = new Set([...this._dispatchingRunIds].filter((id) => id !== run.id));
    return executionLoad(this.runs.filter((item) => item.id !== run.id), others, run.ownerPrincipal) < this.maxConcurrentRuns;
  }

  _runTask(task, opts = {}) {
    if (!this.ctx?.turnOrchestrator) return { ok: false, error: "NOT_READY" };
    if (hasActiveTaskRun(this.runs, task.id)) return { ok: false, error: "ALREADY_RUNNING" };
    if (executionLoad(this.runs, this._dispatchingRunIds, task.ownerPrincipal) >= this.maxConcurrentRuns) {
      return { ok: false, error: "CAPACITY" };
    }
    const scopeError = this._validateScope(task.originSessionId, task.projectId);
    if (scopeError) {
      if (this.selfHeal) this._recordScopeFailure(task, scopeError, opts);
      return { ok: false, error: scopeError, paused: this.selfHeal };
    }
    const scheduledFor = opts.manual ? `manual:${nowIso()}:${crypto.randomUUID()}` : opts.scheduledFor || task.nextRunAt;
    const run = this._newRun(task, scheduledFor, Boolean(opts.manual));
    if (!this.store?.insertRun(run)) {
      if (!opts.manual) {
        task.nextRunAt = nextRunAfterNow(task, scheduledFor, computeNextRunAt);
        this.store?.saveTask(task);
      }
      return { ok: false, error: "DUPLICATE_OCCURRENCE" };
    }
    this.runs.push(run);
    task.status = "queued";
    task.updatedAt = nowIso();
    // A one-shot has no occurrence after the one being run; everything else
    // advances past now so missed occurrences collapse into this run.
    if (!opts.manual) task.nextRunAt = task.schedule?.type === "once" ? null : nextRunAfterNow(task, scheduledFor, computeNextRunAt);
    this.store.saveTask(task);
    log.info("run %s queued for task %s (%s)", run.id, task.id, opts.manual ? "manual" : `due ${scheduledFor}`);
    this._dispatchRun(task, run, { nonInteractive: !opts.manual });
    return { ok: true, queued: true, run };
  }

  _normalizeTask(task) {
    if (!task || typeof task !== "object") return null;
    const ownerPrincipal = String(task.ownerPrincipal || this._principal() || "").trim();
    const schedule = normalizeScheduleSpec(task.schedule);
    const projectId = String(task.projectId || task.workspaceId || "").trim();
    const originSessionId = String(task.originSessionId || task.sessionId || "").trim();
    const prompt = safeText(task.prompt, 4000);
    if (!ownerScopeFromPrincipal(ownerPrincipal)
      || !projectId || !originSessionId || !prompt || !schedule) return null;
    const enabled = task.enabled !== false;
    return {
      id: String(task.id || "").trim() || `sched_${crypto.randomUUID()}`,
      ownerPrincipal,
      workspaceId: projectId,
      projectId,
      sessionId: originSessionId,
      originSessionId,
      executionSessionId: originSessionId,
      title: safeText(task.title, 80) || "Scheduled Task",
      prompt,
      schedule,
      scheduleText: safeText(task.scheduleText, 120) || describeSchedule(schedule),
      permissionMode: DEFAULT_PERMISSION_MODE,
      enabled,
      status: enabled ? (task.status || "scheduled") : (task.status === "completed" ? "completed" : "paused"),
      overlapPolicy: normalizeOverlapPolicy(task.overlapPolicy),
      lastRunAt: task.lastRunAt || null,
      nextRunAt: enabled ? (task.nextRunAt || computeNextRunAt(schedule)) : null,
      missedRunPolicy: normalizeMissedRunPolicy(task.missedRunPolicy),
      pausedReason: enabled ? null : (safeText(task.pausedReason, 80) || null),
      lastError: safeText(task.lastError, 400) || null,
      timezone: safeText(task.timezone, 80) || null,
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
    };
  }

  _validateScope(sessionId, projectId) {
    if (!this.ctx?.sessionManager) return "";
    const session = this.ctx.sessionManager.findById?.(sessionId);
    if (!session) return "SCOPE_MISSING";
    return session.projectId === projectId && this.ctx.projectManager?.find?.(projectId)
      ? ""
      : "SCOPE_MISMATCH";
  }

  _principal() {
    try {
      const principal = String(this._resolvePrincipal() || "").trim();
      return ownerScopeFromPrincipal(principal) ? principal : null;
    } catch {
      return null;
    }
  }
  _findOwnedTask(taskId, scope = {}) {
    const task = this.tasks.find((item) => item.id === String(taskId || "") && item.ownerPrincipal === this._principal());
    if (!task) return null;
    if (scope.projectId && scope.projectId !== task.projectId) return null;
    if (scope.sessionId && scope.sessionId !== task.originSessionId) return null;
    return task;
  }

  _reconcileTaskStates(recovered = []) {
    for (const task of this.tasks) {
      const abandoned = recovered.filter((run) => run.taskId === task.id).at(-1);
      if (abandoned && Date.parse(task.nextRunAt || "") <= Date.parse(abandoned.scheduledFor)) {
        task.nextRunAt = nextRunAfterNow(task, abandoned.scheduledFor, computeNextRunAt);
      }
      // A retired one-shot stays "completed"; only enabled tasks are re-derived.
      task.status = task.enabled
        ? (hasActiveTaskRun(this.runs, task.id) ? task.status : "scheduled")
        : (task.status === "completed" ? "completed" : "paused");
      this.store?.saveTask(task);
    }
  }
}

module.exports = {
  ScheduledTaskManager,
  buildTaskPrompt,
  computeNextRunAt,
  describeSchedule,
  normalizeScheduleSpec,
  parseScheduleFromText,
  sanitizeScheduledTaskPrompt,
};
