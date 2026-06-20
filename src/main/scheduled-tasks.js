"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scheduledTasksPath } = require("./config");
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
  MISSED_GRACE_MS,
  DEFAULT_PERMISSION_MODE,
} = require("./schedule-parser");
const { parseScheduledTaskDraftWithModel } = require("./scheduled-task-ai-draft");

class ScheduledTaskManager {
  constructor() {
    this.tasks = [];
    this.runs = [];
    this.ctx = null;
    this._timer = null;
    this._runningRunIds = new Set();
  }

  load() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(scheduledTasksPath(), "utf8"));
    } catch {
      parsed = null;
    }
    this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.map((task) => this._normalizeTask(task)).filter(Boolean) : [];
    this.runs = Array.isArray(parsed?.runs) ? parsed.runs.slice(-300) : [];
    const now = nowIso();
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        run.finishedAt = now;
        run.error = "Application closed or restarted. Scheduled task was interrupted.";
      }
    }
    this.save();
  }

  start(ctx) {
    this.ctx = ctx;
    this.stop();
    this._timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick({ startup: true }), 1200);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  save() {
    const filePath = scheduledTasksPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ tasks: this.tasks, runs: this.runs.slice(-300) }, null, 2), "utf8");
  }

  parseDraft({ text, sessionId, projectId }) {
    const prompt = safeText(text, 4000);
    if (!prompt) return { ok: false, error: "EMPTY" };
    if (hasScheduledTaskNegation(prompt)) return { ok: false, error: "SCHEDULE_NEGATED" };
    const parsed = parseScheduleFromText(prompt);
    if (!parsed.ok) return parsed;
    const taskPrompt = sanitizeScheduledTaskPrompt(prompt);
    const title = taskPrompt.slice(0, 48) || "Scheduled Task";
    return {
      ok: true,
      draft: {
        title,
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
    const modelParser = this.aiDraftParser || parseScheduledTaskDraftWithModel;
    const modelResult = await modelParser({
      text: prompt,
      sessionId,
      projectId,
      now: nowIso(),
    });
    if (modelResult?.ok) {
      return { ...modelResult, source: modelResult.source || "model" };
    }
    const fallback = this.parseDraft({ text: prompt, sessionId, projectId });
    if (fallback?.ok) {
      return {
        ...fallback,
        source: "local_fallback",
        modelError: modelResult?.error || null,
      };
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
    const now = nowIso();
    const task = this._normalizeTask({
      id: `sched_${crypto.randomUUID()}`,
      workspaceId: payload.projectId,
      projectId: payload.projectId,
      sessionId: payload.sessionId,
      title,
      prompt,
      schedule: parsed.schedule,
      scheduleText: payload.scheduleText || parsed.scheduleText,
      permissionMode: payload.permissionMode || DEFAULT_PERMISSION_MODE,
      enabled: payload.enabled !== false,
      status: "scheduled",
      lastRunAt: null,
      nextRunAt: parsed.nextRunAt,
      missedRunPolicy: "run_once_on_launch",
      createdAt: now,
      updatedAt: now,
    });
    this.tasks.push(task);
    this.save();
    return { ok: true, task };
  }

  list(filter = {}) {
    const sessionId = filter.sessionId ? String(filter.sessionId) : "";
    const projectId = filter.projectId ? String(filter.projectId) : "";
    return {
      ok: true,
      tasks: this.tasks
        .filter((task) => !sessionId || task.sessionId === sessionId)
        .filter((task) => !projectId || task.projectId === projectId)
        .map((task) => ({ ...task, lastRun: this.runs.filter((run) => run.taskId === task.id).at(-1) || null })),
    };
  }

  setEnabled(taskId, enabled) {
    const task = this._findTask(taskId);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    task.enabled = Boolean(enabled);
    task.status = task.enabled ? "scheduled" : "paused";
    task.updatedAt = nowIso();
    if (task.enabled && !task.nextRunAt) task.nextRunAt = computeNextRunAt(task.schedule);
    this.save();
    return { ok: true, task };
  }

  remove(taskId) {
    const existing = this._findTask(taskId);
    if (!existing) return { ok: false, error: "NOT_FOUND" };
    if (existing.status === "queued" || existing.status === "running") {
      return { ok: false, error: "TASK_ACTIVE" };
    }
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== taskId);
    if (before === this.tasks.length) return { ok: false, error: "NOT_FOUND" };
    this.save();
    return { ok: true };
  }

  runNow(taskId) {
    const task = this._findTask(taskId);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    return this._runTask(task, { manual: true });
  }

  async tick() {
    const now = Date.now();
    for (const task of this.tasks) {
      if (!task.enabled) continue;
      if (task.status === "queued" || task.status === "running") continue;
      if (!task.nextRunAt) {
        task.nextRunAt = computeNextRunAt(task.schedule);
        continue;
      }
      if (Date.parse(task.nextRunAt) > now) continue;
      try {
        await this._runTask(task, { scheduled: true });
      } catch (err) {
        // Prevent one failed task from blocking the tick loop
        console.warn("[scheduled-tasks] tick error for %s: %s", task.id, err?.message || err);
      }
    }
  }

  completeRun(sessionId, turnId, terminalType, payload = {}) {
    const run = [...this.runs].reverse().find(
      (item) => item.sessionId === sessionId && item.turnId === turnId && (item.status === "running" || item.status === "queued"),
    );
    if (!run) return false;
    run.status = terminalType === "turn.completed" ? "succeeded" : terminalType.replace(/^turn\./, "");
    run.finishedAt = nowIso();
    run.error = terminalType === "turn.completed" ? null : payload?.error || payload?.errorCode || terminalType;
    this._runningRunIds.delete(run.id);
    const task = this._findTask(run.taskId);
    if (task) {
      task.status = task.enabled ? "scheduled" : "paused";
      task.lastRunAt = run.finishedAt;
      task.nextRunAt = task.enabled ? computeNextRunAt(task.schedule, new Date()) : null;
      task.updatedAt = nowIso();
    }
    this.save();
    return true;
  }

  _runTask(task, opts = {}) {
    if (!this.ctx?.turnOrchestrator) return { ok: false, error: "NOT_READY" };
    if (task.status === "queued" || task.status === "running") {
      return { ok: false, error: "ALREADY_RUNNING" };
    }
    const session = this.ctx.sessionManager?.findById?.(task.sessionId);
    const project = this.ctx.projectManager?.find?.(task.projectId);
    if (!session || !project) {
      task.enabled = false;
      task.status = "paused";
      task.updatedAt = nowIso();
      const run = this._appendRun(task, "skipped", {
        error: !session ? "Original session no longer exists. Scheduled task has been paused." : "Original workspace no longer exists. Scheduled task has been paused.",
      });
      this.save();
      return { ok: false, error: "SCOPE_MISSING", run };
    }

    const run = this._appendRun(task, "queued", { manual: Boolean(opts.manual) });
    task.status = "queued";
    task.updatedAt = nowIso();
    task.nextRunAt = computeNextRunAt(task.schedule, new Date());
    this.save();
    // An unattended scheduled fire must never block on a permission prompt
    // no one will answer — force "plan" (read-only: never prompts; mutations are
    // denied rather than asked). A manual "run now" keeps the session's mode
    // because the user is present to answer.
    const resultPromise = this.ctx.turnOrchestrator.sendUserMessage(task.sessionId, buildTaskPrompt(task), [], {
      recordUser: true,
      spawnEngine: true,
      skipVision: true,
      skipDocument: true,
      scheduledTaskId: task.id,
      scheduledTaskRunId: run.id,
      scheduledTaskTitle: task.title,
      permissionMode: opts.manual ? undefined : "plan",
    });
    Promise.resolve(resultPromise)
      .then((result) => {
        if (!result?.ok) {
          run.status = "failed";
          run.finishedAt = nowIso();
          run.error = result?.detail || result?.error || "Scheduled task failed to start.";
          task.status = task.enabled ? "scheduled" : "paused";
          this.save();
          return;
        }
        if (result.queued) {
          run.status = "queued";
          run.queueItemId = result.itemId || null;
        } else {
          run.status = "running";
          run.turnId = result.turnId || null;
          this._runningRunIds.add(run.id);
        }
        this.save();
      })
      .catch((err) => {
        run.status = "failed";
        run.finishedAt = nowIso();
        run.error = err?.message || "Scheduled task failed to start.";
        task.status = task.enabled ? "scheduled" : "paused";
        this.save();
      });
    return { ok: true, queued: true, run };
  }

  markRunStarted(runId, turnId) {
    const run = this.runs.find((item) => item.id === runId);
    if (!run) return false;
    run.status = "running";
    run.turnId = turnId || run.turnId || null;
    this._runningRunIds.add(run.id);
    const task = this._findTask(run.taskId);
    if (task) task.status = "running";
    this.save();
    return true;
  }

  _appendRun(task, status, extra = {}) {
    const run = {
      id: `run_${crypto.randomUUID()}`,
      taskId: task.id,
      sessionId: task.sessionId,
      projectId: task.projectId,
      status,
      startedAt: nowIso(),
      finishedAt: status === "skipped" ? nowIso() : null,
      turnId: null,
      error: extra.error || null,
      manual: Boolean(extra.manual),
    };
    this.runs.push(run);
    if (this.runs.length > 300) this.runs.splice(0, this.runs.length - 300);
    return run;
  }

  _normalizeTask(task) {
    if (!task || typeof task !== "object") return null;
    const schedule = normalizeScheduleSpec(task.schedule);
    const id = String(task.id || "").trim() || `sched_${crypto.randomUUID()}`;
    const projectId = String(task.projectId || task.workspaceId || "").trim();
    const sessionId = String(task.sessionId || "").trim();
    const prompt = safeText(task.prompt, 4000);
    if (!projectId || !sessionId || !prompt || !schedule) return null;
    const enabled = task.enabled !== false;
    return {
      id,
      workspaceId: projectId,
      projectId,
      sessionId,
      title: safeText(task.title, 80) || "Scheduled Task",
      prompt,
      schedule,
      scheduleText: safeText(task.scheduleText, 120) || describeSchedule(schedule),
      // Display-only. Unattended fires ALWAYS run with "plan" (see
      // _runTask) — a prompt nobody can answer must never hang a task; manual
      // "run now" uses the session's own mode. This field never overrides that.
      permissionMode: task.permissionMode || DEFAULT_PERMISSION_MODE,
      enabled,
      status: enabled ? (task.status === "running" || task.status === "queued" ? "scheduled" : task.status || "scheduled") : "paused",
      lastRunAt: task.lastRunAt || null,
      nextRunAt: enabled ? (task.nextRunAt || computeNextRunAt(schedule)) : null,
      missedRunPolicy: task.missedRunPolicy || "run_once_on_launch",
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
    };
  }

  _findTask(taskId) {
    const id = String(taskId || "");
    return this.tasks.find((task) => task.id === id) || null;
  }
}

module.exports = {
  ScheduledTaskManager,
  // Re-exported from schedule-parser.js for backward compatibility
  buildTaskPrompt,
  computeNextRunAt,
  describeSchedule,
  normalizeScheduleSpec,
  parseScheduleFromText,
  sanitizeScheduledTaskPrompt,
};
