"use strict";

const crypto = require("node:crypto");
const { scheduledTasksPath, scheduledTasksDbPath } = require("./config");
const { ScheduledTaskStore, ACTIVE_RUN_STATUSES } = require("./store/scheduled-task-store");
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

const DEFAULT_MAX_CONCURRENT_RUNS = 3;
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
    const recovered = this.store.recoverExpired(nowIso(), this._leaseOwner);
    const loaded = this.store.load();
    this.tasks = loaded.tasks.map((task) => this._normalizeTask(task)).filter(Boolean);
    this.runs = loaded.runs;
    if (recovered.length) this._reconcileTaskStates(recovered);
    return migration;
  }

  start(ctx) {
    this.ctx = ctx;
    this.stop();
    this._timer = setInterval(() => void this.tick(), TICK_MS);
    this._timer.unref?.();
    const startup = setTimeout(() => void this.tick({ startup: true }), 1200);
    startup.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

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
    if (modelResult?.ok) return { ...modelResult, source: modelResult.source || "model" };
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
    const execution = this._createExecutionSession(payload.projectId, title, id);
    const task = this._normalizeTask({
      id,
      ownerPrincipal: this._principal(),
      projectId: payload.projectId,
      originSessionId: payload.sessionId,
      executionSessionId: execution?.id || payload.sessionId,
      title,
      prompt,
      schedule: parsed.schedule,
      scheduleText: payload.scheduleText || parsed.scheduleText,
      permissionMode: payload.permissionMode || DEFAULT_PERMISSION_MODE,
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
      if (!this._hasActiveRun(task.id)) task.status = "paused";
      task.nextRunAt = null;
    } else {
      task.status = this._hasActiveRun(task.id) ? task.status : "scheduled";
      task.nextRunAt ||= computeNextRunAt(task.schedule);
    }
    this.store?.saveTask(task);
    return { ok: true, task };
  }

  remove(taskId, scope = {}) {
    const task = this._findOwnedTask(taskId, scope);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    if (this._hasActiveRun(task.id)) return { ok: false, error: "TASK_ACTIVE" };
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
    const owner = this._principal();
    let available = this.maxConcurrentRuns - this._activeCount(owner);
    if (available <= 0) return;
    const now = Date.now();
    for (const task of this.tasks) {
      if (available <= 0) break;
      if (task.ownerPrincipal !== owner || !task.enabled || this._hasActiveRun(task.id)) continue;
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
      try {
        this.ctx?.turnOrchestrator?.interrupt?.(run.sessionId, { clearQueue: true });
      } catch {
        // Completion below is authoritative even if the runner already exited.
      }
      this.completeRunById(run.id, "turn.interrupted", { errorCode: "ACCOUNT_CHANGED" });
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

  _runTask(task, opts = {}) {
    if (!this.ctx?.turnOrchestrator) return { ok: false, error: "NOT_READY" };
    if (this._hasActiveRun(task.id)) return { ok: false, error: "ALREADY_RUNNING" };
    if (this._activeCount(task.ownerPrincipal) >= this.maxConcurrentRuns) return { ok: false, error: "CAPACITY" };
    const scopeError = this._validateScope(task.originSessionId, task.projectId);
    const execution = this._ensureExecutionSession(task);
    if (scopeError || !execution || execution.projectId !== task.projectId || execution.automationTaskId && execution.automationTaskId !== task.id) {
      return { ok: false, error: scopeError || "EXECUTION_SCOPE_MISSING" };
    }
    const scheduledFor = opts.manual ? `manual:${nowIso()}:${crypto.randomUUID()}` : opts.scheduledFor || task.nextRunAt;
    const run = this._newRun(task, scheduledFor, Boolean(opts.manual));
    if (!this.store?.insertRun(run)) {
      if (!opts.manual) {
        task.nextRunAt = computeNextRunAt(task.schedule, new Date(Date.parse(scheduledFor) + 1000));
        this.store?.saveTask(task);
      }
      return { ok: false, error: "DUPLICATE_OCCURRENCE" };
    }
    this.runs.push(run);
    task.status = "queued";
    task.updatedAt = nowIso();
    if (!opts.manual) task.nextRunAt = computeNextRunAt(task.schedule, new Date(Date.parse(scheduledFor) + 1000));
    this.store.saveTask(task);
    const resultPromise = this.ctx.turnOrchestrator.sendUserMessage(task.executionSessionId, buildTaskPrompt(task), [], {
      recordUser: true,
      spawnEngine: true,
      skipVision: true,
      skipDocument: true,
      scheduledTaskId: task.id,
      scheduledTaskRunId: run.id,
      scheduledTaskTitle: task.title,
      permissionMode: opts.manual ? undefined : "plan",
      queueOrigin: "scheduled_task",
      queueVisibility: "background",
    });
    Promise.resolve(resultPromise).then((result) => {
      if (!result?.ok) return this._finishRun(run, "turn.failed", { error: result?.detail || result?.error });
      if (result.queued) {
        run.queueItemId = result.itemId || null;
      } else {
        this.markRunStarted(run.id, result.turnId);
      }
      this.store?.saveRun(run);
    }).catch((err) => this._finishRun(run, "turn.failed", { error: err?.message }));
    return { ok: true, queued: true, run };
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
      executionSessionId: String(task.executionSessionId || originSessionId),
      title: safeText(task.title, 80) || "Scheduled Task",
      prompt,
      schedule,
      scheduleText: safeText(task.scheduleText, 120) || describeSchedule(schedule),
      permissionMode: task.permissionMode || DEFAULT_PERMISSION_MODE,
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

  _createExecutionSession(projectId, title, taskId) {
    return this.ctx?.sessionManager?.createAutomationSession?.(
      projectId,
      `Automation: ${title}`,
      taskId,
    ) || null;
  }

  _ensureExecutionSession(task) {
    const current = this.ctx?.sessionManager?.findById?.(task.executionSessionId);
    if (current?.projectId === task.projectId &&
        (current.hidden !== true || current.automationTaskId === task.id)) {
      if (current.hidden === true || !this.ctx?.sessionManager?.createAutomationSession) return current;
    }
    const created = this._createExecutionSession(task.projectId, task.title, task.id);
    if (created) {
      task.executionSessionId = created.id;
      this.store?.saveTask(task);
      return created;
    }
    return current;
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

  _hasActiveRun(taskId) {
    return this.runs.some((run) => run.taskId === taskId && ACTIVE_RUN_STATUSES.has(run.status));
  }

  _activeCount(owner) {
    return this.runs.filter((run) => run.ownerPrincipal === owner && ACTIVE_RUN_STATUSES.has(run.status)).length;
  }

  _reconcileTaskStates(recovered = []) {
    for (const task of this.tasks) {
      const abandoned = recovered.filter((run) => run.taskId === task.id).at(-1);
      if (abandoned && Date.parse(task.nextRunAt || "") <= Date.parse(abandoned.scheduledFor)) {
        task.nextRunAt = computeNextRunAt(task.schedule, new Date(Date.parse(abandoned.scheduledFor) + 1000));
      }
      task.status = task.enabled ? (this._hasActiveRun(task.id) ? task.status : "scheduled") : "paused";
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
