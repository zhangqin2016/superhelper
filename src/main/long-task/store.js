"use strict";

const path = require("node:path");
const { openDatabase } = require("../store/sqlite-db");
const { normalizeScope } = require("./scope-token");
const { ensureWakeNotificationSchema } = require("./wake-notifications");

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"]);
const ACTIVE = new Set(["starting", "running", "stopping"]);

function json(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function stringify(value, fallback) {
  try { return JSON.stringify(value); } catch { return JSON.stringify(fallback); }
}

function text(value, name, limit = 4096) {
  const out = String(value || "").trim();
  if (!out || Buffer.byteLength(out, "utf8") > limit) throw new TypeError(`${name} is invalid`);
  return out;
}

function hydrate(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    ownerScope: row.owner_scope,
    sessionId: row.session_id,
    projectId: row.project_id,
    turnId: row.turn_id,
    command: row.command,
    args: Object.freeze(json(row.args_json, [])),
    cwd: row.cwd,
    replayPolicy: row.replay_policy,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    version: Number(row.version),
    fencingEpoch: Number(row.fencing_epoch),
    leaseHolder: row.lease_holder || "",
    leaseExpiresAt: Number(row.lease_expires_at || 0),
    progressSeq: Number(row.progress_seq || 0),
    progress: Object.freeze(json(row.progress_json, {})),
    lastProgressAt: Number(row.last_progress_at || 0),
    lastObservedAt: Number(row.last_observed_at || 0),
    pid: row.pid == null ? null : Number(row.pid),
    processIdentity: Object.freeze(json(row.process_identity_json, {})),
    stdoutPath: row.stdout_path || "",
    stderrPath: row.stderr_path || "",
    outputFiles: Object.freeze(json(row.output_files_json, [])),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    signal: row.signal || null,
    error: row.error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    terminalAt: row.terminal_at == null ? null : Number(row.terminal_at),
    // When this conversation first read the job's terminal outcome through
    // job_status/job_logs — the fact a wake exists to bring about.
    outcomeObservedAt: row.outcome_observed_at == null ? null : Number(row.outcome_observed_at),
  });
}

/** True when the conversation has already read this job's outcome. */
function outcomeObserved(job) {
  return Boolean(job?.terminalAt && job?.outcomeObservedAt && Number(job.outcomeObservedAt) >= Number(job.terminalAt));
}

function scopeParams(scope) {
  const normalized = normalizeScope(scope);
  return [normalized.ownerScope, normalized.sessionId, normalized.projectId];
}

class LongTaskStore {
  constructor({ filePath, now = Date.now } = {}) {
    this.filePath = path.resolve(text(filePath, "filePath"));
    this.db = openDatabase(this.filePath);
    this.now = now;
    this._migrate();
    ensureWakeNotificationSchema(this.db);
  }

  _ensureColumn(table, column, ddl) {
    const present = this.db.all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
    if (!present) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS long_task_jobs (
        id TEXT PRIMARY KEY,
        owner_scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT NOT NULL,
        replay_policy TEXT NOT NULL DEFAULT 'never',
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        version INTEGER NOT NULL DEFAULT 1,
        fencing_epoch INTEGER NOT NULL DEFAULT 0,
        lease_holder TEXT,
        lease_expires_at INTEGER,
        progress_seq INTEGER NOT NULL DEFAULT 0,
        progress_json TEXT NOT NULL DEFAULT '{}',
        last_progress_at INTEGER,
        last_observed_at INTEGER,
        pid INTEGER,
        process_identity_json TEXT NOT NULL DEFAULT '{}',
        stdout_path TEXT,
        stderr_path TEXT,
        output_files_json TEXT NOT NULL DEFAULT '[]',
        exit_code INTEGER,
        signal TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_long_task_idempotency
        ON long_task_jobs(owner_scope, session_id, project_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_long_task_scope_status
        ON long_task_jobs(owner_scope, session_id, project_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS long_task_wakes (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES long_task_jobs(id),
        owner_scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        version INTEGER NOT NULL DEFAULT 1,
        fencing_epoch INTEGER NOT NULL DEFAULT 0,
        lease_holder TEXT,
        lease_expires_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_long_task_wakes_pending
        ON long_task_wakes(status, lease_expires_at, created_at);
    `);
    this._ensureColumn("long_task_jobs", "outcome_observed_at", "INTEGER");
  }

  createJob(input = {}) {
    const scope = normalizeScope(input.scope);
    const id = text(input.id, "job id", 160);
    const idempotencyKey = text(input.idempotencyKey, "idempotency key", 240);
    const existing = this.db.get(
      `SELECT * FROM long_task_jobs WHERE owner_scope=? AND session_id=? AND project_id=? AND idempotency_key=?`,
      scope.ownerScope, scope.sessionId, scope.projectId, idempotencyKey,
    );
    if (existing) return hydrate(existing);
    const conflicting = this.db.get(`SELECT id FROM long_task_jobs WHERE id=?`, id);
    if (conflicting) throw new Error("JOB_ID_CONFLICT");
    const ts = Number(this.now());
    try {
      this.db.run(
        `INSERT INTO long_task_jobs
          (id,owner_scope,session_id,project_id,turn_id,command,args_json,cwd,
           replay_policy,idempotency_key,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, scope.ownerScope, scope.sessionId, scope.projectId, scope.turnId,
        text(input.command, "command"), stringify(Array.isArray(input.args) ? input.args.map(String) : [], []),
        path.resolve(text(input.cwd, "cwd")),
        ["never", "idempotent", "inspect"].includes(input.replayPolicy) ? input.replayPolicy : "never",
        idempotencyKey, "starting", ts, ts,
      );
      if (Array.isArray(input.outputFiles) && input.outputFiles.length) {
        this.db.run(
          `UPDATE long_task_jobs SET output_files_json=? WHERE id=?`,
          stringify(input.outputFiles.map(String).slice(0, 50), []), id,
        );
      }
    } catch (error) {
      const raced = this.db.get(
        `SELECT * FROM long_task_jobs WHERE owner_scope=? AND session_id=? AND project_id=? AND idempotency_key=?`,
        scope.ownerScope, scope.sessionId, scope.projectId, idempotencyKey,
      );
      if (raced) return hydrate(raced);
      throw error;
    }
    return this.getJob(scope, id);
  }

  getJob(scope, id) {
    const params = scopeParams(scope);
    return hydrate(this.db.get(
      `SELECT * FROM long_task_jobs WHERE owner_scope=? AND session_id=? AND project_id=? AND id=?`,
      ...params, String(id || ""),
    ));
  }

  listJobs(scope, { limit = 50, statuses = null } = {}) {
    const params = scopeParams(scope);
    const wanted = Array.isArray(statuses) ? statuses.filter((item) => ACTIVE.has(item) || TERMINAL.has(item)) : [];
    const where = wanted.length ? ` AND status IN (${wanted.map(() => "?").join(",")})` : "";
    return this.db.all(
      `SELECT * FROM long_task_jobs WHERE owner_scope=? AND session_id=? AND project_id=?${where}
       ORDER BY created_at DESC LIMIT ?`,
      ...params, ...wanted, Math.max(1, Math.min(Number(limit) || 50, 200)),
    ).map(hydrate);
  }

  listActiveJobs({ limit = 500 } = {}) {
    return this.db.all(
      `SELECT * FROM long_task_jobs WHERE status IN ('starting','running','stopping')
       ORDER BY created_at LIMIT ?`,
      Math.max(1, Math.min(Number(limit) || 500, 5_000)),
    ).map(hydrate);
  }

  listJobsByStatus(status, { limit = 500 } = {}) {
    const wanted = String(status || "");
    if (!ACTIVE.has(wanted) && !TERMINAL.has(wanted)) return [];
    return this.db.all(
      `SELECT * FROM long_task_jobs WHERE status=? ORDER BY created_at LIMIT ?`,
      wanted, Math.max(1, Math.min(Number(limit) || 500, 5_000)),
    ).map(hydrate);
  }

  getJobTrusted(id) {
    return hydrate(this.db.get(`SELECT * FROM long_task_jobs WHERE id=?`, String(id || "")));
  }

  /**
   * The conversation read this job's terminal outcome (job_status/job_logs in
   * its own scope). Kept as the FIRST such read. A wake for the job is then
   * redundant: 2026-09-25, four jobs finished while their turn was still
   * running and that turn read each result, yet four wake turns re-reported
   * them for ten minutes after the user's next answer.
   */
  recordOutcomeObserved(scope, id) {
    const job = this.getJob(scope, id);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (!job.terminalAt) return { ok: false, error: "JOB_NOT_TERMINAL", job };
    if (job.outcomeObservedAt) return { ok: true, job };
    const ts = Number(this.now());
    this.db.run(`UPDATE long_task_jobs SET outcome_observed_at=?,updated_at=?,version=version+1 WHERE id=? AND outcome_observed_at IS NULL`, ts, ts, job.id);
    return { ok: true, job: this.getJob(scope, id) };
  }

  pruneTerminal({ olderThanMs = 30 * 24 * 60 * 60_000, maxTerminal = 5_000 } = {}) {
    const cutoff = Number(this.now()) - Math.max(0, Number(olderThanMs) || 0);
    const rows = this.db.all(
      `SELECT * FROM long_task_jobs WHERE terminal_at IS NOT NULL ORDER BY terminal_at DESC`,
    ).map(hydrate);
    const candidates = rows.filter((job, index) => job.terminalAt < cutoff || index >= Math.max(100, Number(maxTerminal) || 5_000));
    const prunedJobs = [];
    this.db.transaction(() => {
      for (const job of candidates) {
        const pending = this.db.get(
          `SELECT 1 AS present FROM long_task_wakes w
           LEFT JOIN long_task_wake_notifications n ON n.wake_id=w.id
           WHERE w.job_id=? AND (w.status='pending' OR (w.status='abandoned' AND n.delivered_at IS NULL)) LIMIT 1`,
          job.id,
        );
        if (pending) continue;
        this.db.run(`DELETE FROM long_task_wake_notifications WHERE wake_id IN
          (SELECT id FROM long_task_wakes WHERE job_id=?)`, job.id);
        this.db.run(`DELETE FROM long_task_wakes WHERE job_id=?`, job.id);
        if (this.db.run(`DELETE FROM long_task_jobs WHERE id=? AND terminal_at IS NOT NULL`, job.id).changes === 1) {
          prunedJobs.push(job);
        }
      }
    })();
    return { prunedJobs };
  }

  claimLease(scope, id, { holder, ttlMs = 30_000, allowRenew = true, forceTakeover = false } = {}) {
    const job = this.getJob(scope, id);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (TERMINAL.has(job.status)) return { ok: false, error: "TERMINAL_IMMUTABLE" };
    const ts = Number(this.now());
    const owner = text(holder, "lease holder", 160);
    if (!forceTakeover && !allowRenew && job.leaseHolder === owner && job.leaseExpiresAt > ts) {
      return { ok: false, error: "LEASE_HELD", job };
    }
    if (!forceTakeover && job.leaseHolder && job.leaseHolder !== owner && job.leaseExpiresAt > ts) {
      return { ok: false, error: "LEASE_HELD", job };
    }
    const epoch = !forceTakeover && job.leaseHolder === owner && job.leaseExpiresAt > ts
      ? job.fencingEpoch
      : job.fencingEpoch + 1;
    const updated = this.db.run(
      `UPDATE long_task_jobs SET lease_holder=?, lease_expires_at=?, fencing_epoch=?,
       version=version+1, updated_at=? WHERE id=? AND version=? AND terminal_at IS NULL`,
      owner, ts + Math.max(1_000, Number(ttlMs) || 0), epoch, ts, job.id, job.version,
    );
    if (updated.changes !== 1) return { ok: false, error: "CAS_RETRY" };
    return { ok: true, job: this.getJob(scope, id) };
  }

  recordProgress(scope, id, input = {}) {
    const job = this.getJob(scope, id);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (TERMINAL.has(job.status)) return { ok: false, error: "TERMINAL_IMMUTABLE" };
    if (job.leaseHolder !== String(input.holder || "") || job.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const seq = Number(input.progressSeq);
    if (!Number.isInteger(seq) || seq <= job.progressSeq) return { ok: false, error: "STALE_PROGRESS" };
    const ts = Number(this.now());
    const updated = this.db.run(
      `UPDATE long_task_jobs SET progress_seq=?,progress_json=?,last_progress_at=?,last_observed_at=?,
       status='running',version=version+1,updated_at=?
       WHERE id=? AND version=? AND lease_holder=? AND fencing_epoch=? AND terminal_at IS NULL`,
      seq, stringify(input.progress || {}, {}), ts, ts, ts,
      job.id, job.version, job.leaseHolder, job.fencingEpoch,
    );
    if (updated.changes !== 1) return { ok: false, error: "CAS_RETRY" };
    return { ok: true, job: this.getJob(scope, id) };
  }

  attachProcess(scope, id, input = {}) {
    const job = this.getJob(scope, id);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (TERMINAL.has(job.status)) return { ok: false, error: "TERMINAL_IMMUTABLE" };
    if (job.leaseHolder !== String(input.holder || "") || job.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const pid = Number(input.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !input.processIdentity) return { ok: false, error: "INVALID_PROCESS_IDENTITY" };
    const ts = Number(this.now());
    const updated = this.db.run(
      `UPDATE long_task_jobs SET pid=?,process_identity_json=?,stdout_path=?,stderr_path=?,
       status='running',last_observed_at=?,updated_at=?,version=version+1
       WHERE id=? AND version=? AND lease_holder=? AND fencing_epoch=? AND terminal_at IS NULL`,
      pid, stringify(input.processIdentity, {}), String(input.stdoutPath || ""), String(input.stderrPath || ""),
      ts, ts, job.id, job.version, job.leaseHolder, job.fencingEpoch,
    );
    if (updated.changes !== 1) return { ok: false, error: "CAS_RETRY" };
    return { ok: true, job: this.getJob(scope, id) };
  }

  observe(scope, id, input = {}) {
    const job = this.getJob(scope, id);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (TERMINAL.has(job.status)) return { ok: true, job };
    if (job.leaseHolder !== String(input.holder || "") || job.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const ts = Number(this.now());
    const updated = this.db.run(
      `UPDATE long_task_jobs SET last_observed_at=?,updated_at=?,version=version+1
       WHERE id=? AND version=? AND lease_holder=? AND fencing_epoch=? AND terminal_at IS NULL`,
      ts, ts, job.id, job.version, job.leaseHolder, job.fencingEpoch,
    );
    if (updated.changes !== 1) return { ok: false, error: "CAS_RETRY" };
    return { ok: true, job: this.getJob(scope, id) };
  }

  markTerminal(scope, id, input = {}) {
    const job = this.getJob(scope, id);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (TERMINAL.has(job.status)) return { ok: false, error: "TERMINAL_IMMUTABLE", job };
    if (job.leaseHolder !== String(input.holder || "") || job.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const status = String(input.status || "");
    if (!TERMINAL.has(status)) return { ok: false, error: "INVALID_TERMINAL_STATUS" };
    const ts = Number(this.now());
    const files = Array.isArray(input.outputFiles) ? input.outputFiles.map(String).slice(0, 50) : job.outputFiles;
    const updated = this.db.run(
      `UPDATE long_task_jobs SET status=?,exit_code=?,signal=?,error=?,output_files_json=?,
       terminal_at=?,updated_at=?,version=version+1,lease_expires_at=NULL
       WHERE id=? AND version=? AND lease_holder=? AND fencing_epoch=? AND terminal_at IS NULL`,
      status, input.exitCode ?? null, input.signal || null, input.error || null,
      stringify(files, []), ts, ts, job.id, job.version, job.leaseHolder, job.fencingEpoch,
    );
    if (updated.changes !== 1) return { ok: false, error: "CAS_RETRY" };
    return { ok: true, job: this.getJob(scope, id) };
  }

  close() { this.db.close(); }
}

require("./wake-store").installWakeStore(LongTaskStore, { text });

module.exports = { ACTIVE_LONG_TASK_STATUSES: ACTIVE, LongTaskStore, TERMINAL_LONG_TASK_STATUSES: TERMINAL, outcomeObserved };
