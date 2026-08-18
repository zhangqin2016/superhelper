"use strict";

const path = require("node:path");
const { openDatabase } = require("../store/sqlite-db");
const { normalizeScope } = require("./scope-token");

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
  });
}

function hydrateWake(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    jobId: row.job_id,
    ownerScope: row.owner_scope,
    sessionId: row.session_id,
    projectId: row.project_id,
    turnId: row.turn_id,
    status: row.status,
    version: Number(row.version),
    fencingEpoch: Number(row.fencing_epoch),
    leaseHolder: row.lease_holder || "",
    leaseExpiresAt: Number(row.lease_expires_at || 0),
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
  });
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

  enqueueWakeForJob(jobId) {
    const job = this.getJobTrusted(jobId);
    if (!job) return { ok: false, error: "JOB_NOT_FOUND" };
    if (!["succeeded", "failed", "outcome_unknown"].includes(job.status)) {
      return { ok: false, error: "JOB_NOT_WAKEABLE" };
    }
    if (job.ownerScope === "legacy-local") return { ok: false, error: "LEGACY_JOB_UNSCOPED" };
    const ts = Number(this.now());
    const id = `wake:${job.id}`;
    this.db.run(
      `INSERT OR IGNORE INTO long_task_wakes
       (id,job_id,owner_scope,session_id,project_id,turn_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'pending',?,?)`,
      id, job.id, job.ownerScope, job.sessionId, job.projectId, job.turnId, ts, ts,
    );
    return { ok: true, wake: this.getWake(id) };
  }

  getWake(id) {
    return hydrateWake(this.db.get(`SELECT * FROM long_task_wakes WHERE id=?`, String(id || "")));
  }

  listPendingWakes({ limit = 500 } = {}) {
    return this.db.all(
      `SELECT * FROM long_task_wakes WHERE status='pending' ORDER BY created_at LIMIT ?`,
      Math.max(1, Math.min(Number(limit) || 500, 5_000)),
    ).map(hydrateWake);
  }

  claimPendingWakes({ holder, ttlMs = 30_000, limit = 20 } = {}) {
    const owner = text(holder, "wake lease holder", 160);
    const ts = Number(this.now());
    const max = Math.max(1, Math.min(Number(limit) || 20, 100));
    return this.db.transaction(() => {
      const candidates = this.db.all(
        `SELECT * FROM long_task_wakes
         WHERE status='pending' AND (lease_holder IS NULL OR lease_expires_at<=? OR lease_holder=?)
         ORDER BY created_at LIMIT ?`,
        ts, owner, max,
      );
      const claimed = [];
      for (const row of candidates) {
        const retryDelay = Number(row.attempt_count || 0) === 0
          ? 0
          : Math.min(5 * 60_000, 2_000 * (2 ** Math.min(8, Number(row.attempt_count) - 1)));
        if (Number(row.updated_at || 0) + retryDelay > ts) continue;
        const epoch = row.lease_holder === owner && Number(row.lease_expires_at || 0) > ts
          ? Number(row.fencing_epoch)
          : Number(row.fencing_epoch) + 1;
        const updated = this.db.run(
          `UPDATE long_task_wakes SET lease_holder=?,lease_expires_at=?,fencing_epoch=?,
           attempt_count=attempt_count+1,version=version+1,updated_at=?
           WHERE id=? AND version=? AND status='pending'
             AND (lease_holder IS NULL OR lease_expires_at<=? OR lease_holder=?)`,
          owner, ts + Math.max(1_000, Number(ttlMs) || 0), epoch, ts,
          row.id, row.version, ts, owner,
        );
        if (updated.changes === 1) claimed.push(this.getWake(row.id));
      }
      return claimed;
    })();
  }

  completeWake(id, input = {}) {
    const wake = this.getWake(id);
    if (!wake) return { ok: false, error: "WAKE_NOT_FOUND" };
    if (wake.status === "delivered") return { ok: true, duplicate: true, wake };
    if (wake.leaseHolder !== String(input.holder || "") || wake.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const ts = Number(this.now());
    const updated = this.db.run(
      `UPDATE long_task_wakes SET status='delivered',delivered_at=?,updated_at=?,version=version+1,
       lease_holder=NULL,lease_expires_at=NULL,last_error=NULL
       WHERE id=? AND version=? AND status='pending' AND lease_holder=? AND fencing_epoch=?`,
      ts, ts, wake.id, wake.version, wake.leaseHolder, wake.fencingEpoch,
    );
    return updated.changes === 1
      ? { ok: true, wake: this.getWake(id) }
      : { ok: false, error: "CAS_RETRY" };
  }

  releaseWake(id, input = {}) {
    const wake = this.getWake(id);
    if (!wake) return { ok: false, error: "WAKE_NOT_FOUND" };
    if (wake.status === "delivered") return { ok: false, error: "TERMINAL_IMMUTABLE", wake };
    if (wake.leaseHolder !== String(input.holder || "") || wake.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const ts = Number(this.now());
    const updated = this.db.run(
      `UPDATE long_task_wakes SET lease_holder=NULL,lease_expires_at=NULL,last_error=?,
       updated_at=?,version=version+1 WHERE id=? AND version=? AND status='pending'
       AND lease_holder=? AND fencing_epoch=?`,
      String(input.error || "WAKE_DELIVERY_FAILED").slice(0, 2000), ts,
      wake.id, wake.version, wake.leaseHolder, wake.fencingEpoch,
    );
    return updated.changes === 1
      ? { ok: true, wake: this.getWake(id) }
      : { ok: false, error: "CAS_RETRY" };
  }

  abandonWake(id, input = {}) {
    const wake = this.getWake(id);
    if (!wake) return { ok: false, error: "WAKE_NOT_FOUND" };
    if (wake.status !== "pending") return { ok: false, error: "TERMINAL_IMMUTABLE", wake };
    if (wake.leaseHolder !== String(input.holder || "") || wake.fencingEpoch !== Number(input.fencingEpoch)) {
      return { ok: false, error: "FENCE_REJECTED" };
    }
    const ts = Number(this.now());
    const updated = this.db.run(
      `UPDATE long_task_wakes SET status='abandoned',last_error=?,delivered_at=?,updated_at=?,
       version=version+1,lease_holder=NULL,lease_expires_at=NULL
       WHERE id=? AND version=? AND status='pending' AND lease_holder=? AND fencing_epoch=?`,
      String(input.error || "WAKE_ABANDONED").slice(0, 2000), ts, ts,
      wake.id, wake.version, wake.leaseHolder, wake.fencingEpoch,
    );
    return updated.changes === 1
      ? { ok: true, wake: this.getWake(id) }
      : { ok: false, error: "CAS_RETRY" };
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
          `SELECT 1 AS present FROM long_task_wakes WHERE job_id=? AND status='pending' LIMIT 1`,
          job.id,
        );
        if (pending) continue;
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

module.exports = { ACTIVE_LONG_TASK_STATUSES: ACTIVE, LongTaskStore, TERMINAL_LONG_TASK_STATUSES: TERMINAL };
