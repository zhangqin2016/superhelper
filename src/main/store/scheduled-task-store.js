"use strict";

const fs = require("node:fs");
const { openDatabase } = require("./sqlite-db");

const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "dispatch_unknown",
  "promoted",
]);

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerPrincipal: row.owner_principal,
    workspaceId: row.project_id,
    projectId: row.project_id,
    sessionId: row.origin_session_id,
    originSessionId: row.origin_session_id,
    executionSessionId: row.execution_session_id || null,
    title: row.title,
    prompt: row.prompt,
    schedule: parseJson(row.schedule_json, {}),
    scheduleText: row.schedule_text,
    permissionMode: row.permission_mode,
    enabled: Boolean(row.enabled),
    status: row.status,
    overlapPolicy: row.overlap_policy,
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    missedRunPolicy: row.missed_run_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    ownerPrincipal: row.owner_principal,
    sessionId: row.execution_session_id,
    originSessionId: row.origin_session_id,
    projectId: row.project_id,
    scheduledFor: row.scheduled_for,
    occurrenceKey: row.occurrence_key,
    status: row.status,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    queuedAt: row.queued_at || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    turnId: row.turn_id || null,
    queueItemId: row.queue_item_id || null,
    error: row.error || null,
    manual: Boolean(row.manual),
    dispatchAttemptId: row.dispatch_attempt_id || null,
    dispatchStartedAt: row.dispatch_started_at || null,
    engineAcceptedAt: row.engine_accepted_at || null,
  };
}

class ScheduledTaskStore {
  constructor(filePath) {
    this.db = openDatabase(filePath);
    this.db.migrate([
      (db) => db.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          owner_principal TEXT NOT NULL,
          project_id TEXT NOT NULL,
          origin_session_id TEXT NOT NULL,
          execution_session_id TEXT,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_json TEXT NOT NULL,
          schedule_text TEXT NOT NULL,
          permission_mode TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          status TEXT NOT NULL,
          overlap_policy TEXT NOT NULL,
          last_run_at TEXT,
          next_run_at TEXT,
          missed_run_policy TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX scheduled_tasks_owner_due
          ON scheduled_tasks(owner_principal, enabled, next_run_at);
        CREATE TABLE scheduled_task_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
          owner_principal TEXT NOT NULL,
          project_id TEXT NOT NULL,
          origin_session_id TEXT NOT NULL,
          execution_session_id TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          occurrence_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          queued_at TEXT,
          started_at TEXT,
          finished_at TEXT,
          turn_id TEXT,
          queue_item_id TEXT,
          error TEXT,
          manual INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX scheduled_runs_active
          ON scheduled_task_runs(owner_principal, status, lease_expires_at);
      `),
      (db) => db.exec(`
        ALTER TABLE scheduled_task_runs ADD COLUMN dispatch_attempt_id TEXT;
        ALTER TABLE scheduled_task_runs ADD COLUMN dispatch_started_at INTEGER;
        ALTER TABLE scheduled_task_runs ADD COLUMN engine_accepted_at INTEGER;
        CREATE INDEX scheduled_runs_turn_reconcile
          ON scheduled_task_runs(owner_principal, execution_session_id, turn_id);
      `),
    ]);
  }

  load() {
    return {
      tasks: this.db.all("SELECT * FROM scheduled_tasks ORDER BY created_at").map(taskFromRow),
      runs: this.db.all("SELECT * FROM scheduled_task_runs ORDER BY queued_at").map(runFromRow),
    };
  }

  countTasks() {
    return Number(this.db.get("SELECT COUNT(*) AS count FROM scheduled_tasks")?.count || 0);
  }

  saveTask(task) {
    this.db.run(`
      INSERT INTO scheduled_tasks (
        id, owner_principal, project_id, origin_session_id, execution_session_id,
        title, prompt, schedule_json, schedule_text, permission_mode, enabled,
        status, overlap_policy, last_run_at, next_run_at, missed_run_policy,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        execution_session_id=excluded.execution_session_id,
        title=excluded.title, prompt=excluded.prompt,
        schedule_json=excluded.schedule_json, schedule_text=excluded.schedule_text,
        permission_mode=excluded.permission_mode, enabled=excluded.enabled,
        status=excluded.status, overlap_policy=excluded.overlap_policy,
        last_run_at=excluded.last_run_at, next_run_at=excluded.next_run_at,
        missed_run_policy=excluded.missed_run_policy, updated_at=excluded.updated_at
    `, task.id, task.ownerPrincipal, task.projectId, task.originSessionId,
    task.executionSessionId || null, task.title, task.prompt,
    JSON.stringify(task.schedule), task.scheduleText, task.permissionMode,
    task.enabled ? 1 : 0, task.status, task.overlapPolicy, task.lastRunAt,
    task.nextRunAt, task.missedRunPolicy, task.createdAt, task.updatedAt);
  }

  deleteTask(taskId) {
    this.db.run("DELETE FROM scheduled_tasks WHERE id = ?", taskId);
  }

  insertRun(run) {
    try {
      this.db.run(`
        INSERT INTO scheduled_task_runs (
          id, task_id, owner_principal, project_id, origin_session_id,
          execution_session_id, scheduled_for, occurrence_key, status,
          lease_owner, lease_expires_at, queued_at, started_at, finished_at,
          turn_id, queue_item_id, error, manual
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, run.id, run.taskId, run.ownerPrincipal, run.projectId,
      run.originSessionId, run.sessionId, run.scheduledFor, run.occurrenceKey,
      run.status, run.leaseOwner, run.leaseExpiresAt, run.queuedAt,
      run.startedAt, run.finishedAt, run.turnId, run.queueItemId, run.error,
      run.manual ? 1 : 0);
      return true;
    } catch (err) {
      if (String(err?.message || err).includes("UNIQUE constraint failed")) return false;
      throw err;
    }
  }

  saveRun(run) {
    this.db.run(`
      UPDATE scheduled_task_runs SET status=?, lease_owner=?,
        lease_expires_at=?, started_at=?, finished_at=?, turn_id=?,
        queue_item_id=?, error=?, dispatch_attempt_id=?,
        dispatch_started_at=?, engine_accepted_at=? WHERE id=?
    `, run.status, run.leaseOwner, run.leaseExpiresAt, run.startedAt,
    run.finishedAt, run.turnId, run.queueItemId, run.error,
    run.dispatchAttemptId || null, run.dispatchStartedAt || null,
    run.engineAcceptedAt || null, run.id);
  }

  importLegacy(legacyPath, normalizeTask, ownerPrincipal) {
    if (this.countTasks() > 0 || !fs.existsSync(legacyPath)) return { ok: true, imported: 0 };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    } catch (err) {
      return { ok: false, error: "LEGACY_CORRUPT", detail: err?.message || String(err) };
    }
    const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
      .map((task) => normalizeTask({ ...task, ownerPrincipal }))
      .filter(Boolean);
    const importAll = this.db.transaction(() => {
      for (const task of tasks) this.saveTask(task);
    });
    importAll();
    const backup = `${legacyPath}.imported-${Date.now()}`;
    fs.renameSync(legacyPath, backup);
    return { ok: true, imported: tasks.length, backup };
  }

  recoverExpired(nowIso, leaseOwner = "", leaseExpiresAt = nowIso) {
    let expired = [];
    const recoverAll = this.db.transaction(() => {
      expired = this.db.all(`
        SELECT * FROM scheduled_task_runs
        WHERE status IN ('queued', 'running')
          AND (lease_expires_at <= ? OR lease_owner <> ?)
      `, nowIso, leaseOwner).map(runFromRow);
      for (const run of expired) {
        run.recoveredFromStatus = run.status;
        if (run.status === "queued") {
          run.leaseOwner = leaseOwner;
          run.leaseExpiresAt = leaseExpiresAt;
          run.finishedAt = null;
          run.queueItemId = null;
          run.error = null;
        } else {
          run.status = "dispatch_unknown";
          run.leaseExpiresAt = null;
          run.finishedAt = null;
          run.error = "Scheduler stopped after dispatch; the durable turn outcome is unknown.";
        }
        this.saveRun(run);
      }
    });
    recoverAll();
    return expired;
  }

  close() {
    this.db.close();
  }
}

module.exports = { ScheduledTaskStore, ACTIVE_RUN_STATUSES };
