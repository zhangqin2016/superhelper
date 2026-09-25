"use strict";

/**
 * The wake half of the long-task store: one durable wake per finished job,
 * leased and settled by the supervisor. Same table, same database; a
 * separate module so each half can be read whole (store.js holds the jobs).
 */

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

function installWakeStore(StoreClass, { text }) {
  Object.assign(StoreClass.prototype, {
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
    },

    getWake(id) {
      return hydrateWake(this.db.get(`SELECT * FROM long_task_wakes WHERE id=?`, String(id || "")));
    },

    listPendingWakes({ limit = 500 } = {}) {
      return this.db.all(
        `SELECT * FROM long_task_wakes WHERE status='pending' ORDER BY created_at LIMIT ?`,
        Math.max(1, Math.min(Number(limit) || 500, 5_000)),
      ).map(hydrateWake);
    },

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
    },

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
    },

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
    },

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
    },
  });
}

module.exports = { hydrateWake, installWakeStore };
