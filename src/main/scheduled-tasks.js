"use strict";

const crypto = require("node:crypto");
const { scheduledTasksPath, scheduledTasksDbPath } = require("./config");
const { ScheduledTaskStore, ACTIVE_RUN_STATUSES } = require("./store/scheduled-task-store");
const { dispatchScheduledRun, interruptForeignScheduledRun } = require("./scheduled-task-dispatch");
const {
  DEFAULT_MAX_CONCURRENT_RUNS,
  executionLoad,
  hasActiveTaskRun,
  nextRunAfterNow,
  runningRunCount,
} = require("./scheduled-task-run-policy");
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
const { parseScheduledTaskDraftWithModel } = require("./scheduled-task-ai-draft");

const DEFAULT_LEASE_MS = 30 * 60 * 1000;

function defaultPrincipal() {
  try {
    const status = require("./account-manager").accountStatus();
    if (status?.loggedIn && status.user?.id) return `user:${status.user.id}`;
  } catch {
    // Offline startup still has a stable device identity.
  }
  try {
    return `device:${require("./service-client").getDeviceId()}`;
  } catch {
    return "device:unavailable";
  }
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
    this.store = null;
  }

  load() {
    this.store ||= new ScheduledTaskStore(this.options.dbPath || scheduledTasksDbPath());
    const migration = this.store.importLegacy(
      this.options.legacyPath || scheduledTasksPath(),
      (task) => this._normalizeTask(task),
      this._principal(),
    );
    const recovered = this.store.recoverExpired(
      nowIso(),
      this._leaseOwner,
      new Date(Date.now() + this.leaseMs).toISOString(),
    );
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
    this._timer = setInterval(() => void this.tick(), TICK_MS);
    this._timer.unref?.();
    this._dispatchRecoveredQueuedRuns();
    this._startupTimer = setTimeout(() => void this.tick({ startup: true }), 1200);
    this._startupTimer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._startupTimer) clearTimeout(this._startupTimer);
    this._timer = null;
    this._startupTimer = null;
  }

  close() { this.stop(); this.store?.close(); this.store = null; }
  save() {
    if (!this.store) return;
    for (const task of this.tasks) this.store.saveTask(task);
    for (const run of this.runs) this.store.saveRun(run);
  }

  parseDraft({ text, sessionId, projectId }) {
    const prompt = safeText(text, 4000);
    if (!prompt) return { ok: false, error: "EMPTY" };
    if (hasScheduledTaskNegation(prompt)) return { ok: false, error: "SCHEDULE_NEGATED" };
    const parsed = parseScheduleFromText(prompt);
    if (!parsed.ok) return parsed;
    const taskPrompt = sanitizeScheduledTaskPrompt(prompt);
    return {
      ok: true,
      draft: {
        title: taskPrompt.slice(0, 48) || "Scheduled Task",
        prompt: taskPrompt,
        schedule: parsed.schedule,
        scheduleText: parsed.scheduleText,
        nextRunAt: parsed.nextRunAt,
        permissionMode: DEFAULT_PERMISSION_MODE,
        sessionId,
        projectId,
      },
    };
  }

  async parseDraftSmart({ text, sessionId, projectId }) {
    const prompt = safeText(text, 4000);
    if (!prompt) return { ok: false, error: "EMPTY" };
    if (hasScheduledTaskNegation(prompt)) return { ok: false, error: "SCHEDULE_NEGATED" };
    const modelResult = await (this.aiDraftParser || parseScheduledTaskDraftWithModel)({
      text: prompt,
      sessionId,
      projectId,
      now: nowIso(),
    });
    if (modelResult?.ok) return { ...modelResult, draft: { ...modelResult.draft, permissionMode: DEFAULT_PERMISSION_MODE }, source: modelResult.source || "model" };
    const fallback = this.parseDraft({ text: prompt, sessionId, projectId });
    if (fallback?.ok) {
      return { ...fallback, source: "local_fallback", modelError: modelResult?.error || null };
    }
    return {
      ok: false,
      error: modelResult?.error || fallback?.error || "SCHEDULE_NOT_FOUND",
      fallbackError: fallback?.error || null,
    };
  }

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
    if (!parsed.ok || !parsed.nextRunAt) return { ok: false, error: parsed.error || "INVALID_SCHEDULE" };
    const scopeError = this._validateScope(payload.sessionId, payload.projectId);
    if (scopeError) return { ok: false, error: scopeError };
    const now = nowIso();
    const id = `sched_${crypto.randomUUID()}`;
    const task = this._normalizeTask({
      id,
      ownerPrincipal: this._principal(),
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
      overlapPolicy: "queue",
      lastRunAt: null,
      nextRunAt: payload.enabled === false ? null : parsed.nextRunAt,
      missedRunPolicy: "run_once_on_launch",
      createdAt: now,
      updatedAt: now,
    });
    this.tasks.push(task);
    this.store?.saveTask(task);
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
    return { ok: true, tasks, skipped: normalized.skipped + (normalized.templates.length - tasks.length) };
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
    task.enabled = Boolean(enabled);
    task.updatedAt = nowIso();
    if (!task.enabled) {
      if (!hasActiveTaskRun(this.runs, task.id)) task.status = "paused";
      task.nextRunAt = null;
    } else {
      task.status = hasActiveTaskRun(this.runs, task.id) ? task.status : "scheduled";
      task.nextRunAt ||= computeNextRunAt(task.schedule);
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

  async tick() {
    this._dispatchRecoveredQueuedRuns();
    const owner = this._principal();
    let available = this.maxConcurrentRuns - executionLoad(this.runs, this._dispatchingRunIds, owner);
    if (available <= 0) return;
    const now = Date.now();
    for (const task of this.tasks) {
      if (available <= 0) break;
      if (task.ownerPrincipal !== owner || !task.enabled || hasActiveTaskRun(this.runs, task.id)) continue;
      if (!task.nextRunAt) {
        task.nextRunAt = computeNextRunAt(task.schedule);
        this.store?.saveTask(task);
        continue;
      }
      if (Date.parse(task.nextRunAt) > now) continue;
      const result = this._runTask(task, { scheduled: true, scheduledFor: task.nextRunAt });
      if (result.ok) available -= 1;
    }
  }

  handlePrincipalChange() {
    const current = this._principal();
    for (const run of this.runs) {
      if (!ACTIVE_RUN_STATUSES.has(run.status) || run.ownerPrincipal === current) continue;
      interruptForeignScheduledRun(this.ctx, run, (...args) => this.completeRunById(...args));
    }
    void this.tick();
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

  markRunStarted(runId, turnId) {
    const run = this.runs.find((item) => item.id === runId && item.status === "queued");
    if (!run) return false;
    run.status = "running";
    run.startedAt = nowIso();
    run.turnId = turnId || null;
    run.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    const task = this.tasks.find((item) => item.id === run.taskId);
    if (task) {
      task.status = "running";
      this.store?.saveTask(task);
    }
    this.store?.saveRun(run);
    return true;
  }

  canStartRun(runId) {
    const run = this.runs.find((item) => item.id === runId && ACTIVE_RUN_STATUSES.has(item.status));
    if (!run) return false;
    if (run.status === "running") return true;
    return runningRunCount(this.runs, run.ownerPrincipal) < this.maxConcurrentRuns;
  }

  _runTask(task, opts = {}) {
    if (!this.ctx?.turnOrchestrator) return { ok: false, error: "NOT_READY" };
    if (hasActiveTaskRun(this.runs, task.id)) return { ok: false, error: "ALREADY_RUNNING" };
    if (executionLoad(this.runs, this._dispatchingRunIds, task.ownerPrincipal) >= this.maxConcurrentRuns) {
      return { ok: false, error: "CAPACITY" };
    }
    const scopeError = this._validateScope(task.originSessionId, task.projectId);
    if (scopeError) return { ok: false, error: scopeError };
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
    if (!opts.manual) task.nextRunAt = nextRunAfterNow(task, scheduledFor, computeNextRunAt);
    this.store.saveTask(task);
    this._dispatchRun(task, run, { nonInteractive: !opts.manual });
    return { ok: true, queued: true, run };
  }

  _dispatchRun(task, run, opts = {}) {
    this._dispatchingRunIds.add(run.id);
    dispatchScheduledRun({
      ctx: this.ctx, task, run, nonInteractive: opts.nonInteractive,
      markRunStarted: (runId, turnId) => this.markRunStarted(runId, turnId),
      finishRun: (target, type, payload) => this._finishRun(target, type, payload),
      saveRun: (target) => this.store?.saveRun(target),
      onSettled: () => {
        this._dispatchingRunIds.delete(run.id);
        queueMicrotask(() => void this.tick());
      },
    });
  }

  _dispatchRecoveredQueuedRuns() {
    for (const runId of this._recoveredQueuedRunIds) {
      const run = this.runs.find((item) => item.id === runId && item.status === "queued");
      const task = run && this.tasks.find((item) => item.id === run.taskId);
      if (!run || !task) {
        this._recoveredQueuedRunIds.delete(runId);
        continue;
      }
      if (run.ownerPrincipal !== this._principal()) continue;
      if (executionLoad(this.runs, this._dispatchingRunIds, run.ownerPrincipal) >= this.maxConcurrentRuns) break;
      this._recoveredQueuedRunIds.delete(runId);
      this._dispatchRun(task, run, { nonInteractive: true });
    }
  }

  _finishRun(run, terminalType, payload = {}) {
    run.status = terminalType === "turn.completed" ? "succeeded" : terminalType.replace(/^turn\./, "");
    run.finishedAt = nowIso();
    run.leaseExpiresAt = null;
    run.error = run.status === "succeeded" ? null : payload?.error || payload?.errorCode || terminalType;
    this.store?.saveRun(run);
    const task = this.tasks.find((item) => item.id === run.taskId);
    if (task) {
      task.status = task.enabled ? "scheduled" : "paused";
      task.lastRunAt = run.finishedAt;
      task.updatedAt = nowIso();
      this.store?.saveTask(task);
      const assistant = safeText(payload?.assistant, 12000);
      if (assistant && task.originSessionId !== task.executionSessionId) {
        this.ctx?.sessionManager?.pushMessageTo?.(task.originSessionId, "assistant", assistant, null, {
          meta: {
            scheduledTaskId: task.id,
            scheduledTaskRunId: run.id,
            executionSessionId: task.executionSessionId,
          },
        });
      }
    }
    queueMicrotask(() => void this.tick());
  }

  _newRun(task, scheduledFor, manual) {
    const queuedAt = nowIso();
    return {
      id: `run_${crypto.randomUUID()}`,
      taskId: task.id,
      ownerPrincipal: task.ownerPrincipal,
      sessionId: task.executionSessionId,
      originSessionId: task.originSessionId,
      projectId: task.projectId,
      scheduledFor,
      occurrenceKey: `${task.id}:${scheduledFor}`,
      status: "queued",
      leaseOwner: this._leaseOwner,
      leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
      queuedAt,
      startedAt: null,
      finishedAt: null,
      turnId: null,
      queueItemId: null,
      error: null,
      manual,
    };
  }

  _normalizeTask(task) {
    if (!task || typeof task !== "object") return null;
    const schedule = normalizeScheduleSpec(task.schedule);
    const projectId = String(task.projectId || task.workspaceId || "").trim();
    const originSessionId = String(task.originSessionId || task.sessionId || "").trim();
    const prompt = safeText(task.prompt, 4000);
    if (!projectId || !originSessionId || !prompt || !schedule) return null;
    const enabled = task.enabled !== false;
    return {
      id: String(task.id || "").trim() || `sched_${crypto.randomUUID()}`,
      ownerPrincipal: String(task.ownerPrincipal || this._principal()),
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
      status: enabled ? (task.status || "scheduled") : "paused",
      overlapPolicy: task.overlapPolicy || "queue",
      lastRunAt: task.lastRunAt || null,
      nextRunAt: enabled ? (task.nextRunAt || computeNextRunAt(schedule)) : null,
      missedRunPolicy: task.missedRunPolicy || "run_once_on_launch",
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
    return String(this._resolvePrincipal() || "device:unavailable");
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
      task.status = task.enabled ? (hasActiveTaskRun(this.runs, task.id) ? task.status : "scheduled") : "paused";
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
