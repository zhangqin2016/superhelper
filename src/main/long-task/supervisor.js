"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { LongTaskStore, TERMINAL_LONG_TASK_STATUSES } = require("./store");
const { matchesProcessIdentity } = require("./process-identity");
const { enforceGlobalLogQuota } = require("./log-policy");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

class LongTaskSupervisor {
  constructor(options = {}) {
    this.dbPath = options.dbPath;
    this.jobsDir = options.jobsDir || path.join(path.dirname(this.dbPath), "process-jobs");
    this.holder = options.holder || `long-task-supervisor:${process.pid}`;
    this.leaseMs = Math.max(1_000, Number(options.leaseMs) || 30_000);
    this.intervalMs = Math.max(500, Number(options.intervalMs) || 2_000);
    this.now = options.now || Date.now;
    this.matchesIdentity = options.matchesIdentity || matchesProcessIdentity;
    this.onWake = options.onWake || (async () => ({ ok: false, error: "WAKE_HANDLER_UNAVAILABLE" }));
    this.timer = null;
    this.running = null;
  }

  _store() { return new LongTaskStore({ filePath: this.dbPath, now: this.now }); }
  _scope(job) {
    return { ownerScope: job.ownerScope, sessionId: job.sessionId, projectId: job.projectId, turnId: job.turnId };
  }

  _alive(job) {
    if (job.processIdentity?.reconnectSafe !== false) {
      return this.matchesIdentity(job.processIdentity);
    }
    const heartbeat = readJson(job.processIdentity.heartbeatPath);
    return Boolean(
      heartbeat
      && heartbeat.launchNonce === job.processIdentity.launchNonce
      && Number(this.now()) - Number(heartbeat.observedAt || 0) < 10_000
    );
  }

  async reconcileOnce() {
    const counts = { observed: 0, succeeded: 0, failed: 0, outcomeUnknown: 0, skipped: 0 };
    const store = this._store();
    try {
      for (const candidate of store.listActiveJobs()) {
        const scope = this._scope(candidate);
        const lease = store.claimLease(scope, candidate.id, { holder: this.holder, ttlMs: this.leaseMs });
        if (!lease.ok) { counts.skipped += 1; continue; }
        const job = lease.job;
        const marker = readJson(path.join(this.jobsDir, `${job.id}.terminal.json`));
        let status = null;
        let error = null;
        if (marker && marker.launchNonce === job.processIdentity?.launchNonce) {
          status = marker.exitCode === 0 ? "succeeded" : "failed";
          error = marker.error || null;
        } else {
          if (!this._alive(job)) {
            status = job.status === "starting" ? "failed" : "outcome_unknown";
            error = "PROCESS_EXITED_WITHOUT_TERMINAL_MARKER";
          }
        }
        if (!status) {
          store.observe(scope, job.id, {
            holder: this.holder, fencingEpoch: job.fencingEpoch,
          });
          counts.observed += 1;
          continue;
        }
        const terminal = store.markTerminal(scope, job.id, {
          holder: this.holder, fencingEpoch: job.fencingEpoch, status,
          exitCode: marker?.exitCode, signal: marker?.signal, error,
        });
        if (!terminal.ok && terminal.error !== "TERMINAL_IMMUTABLE") continue;
        store.enqueueWakeForJob(job.id);
        if (status === "succeeded") counts.succeeded += 1;
        else if (status === "failed") counts.failed += 1;
        else counts.outcomeUnknown += 1;
      }
      for (const status of ["succeeded", "failed", "outcome_unknown"]) {
        for (const job of store.listJobsByStatus(status)) store.enqueueWakeForJob(job.id);
      }
      return counts;
    } finally { store.close(); }
  }

  async deliverWakesOnce() {
    const result = { claimed: 0, delivered: 0, released: 0, abandoned: 0 };
    const store = this._store();
    try {
      const wakes = store.claimPendingWakes({ holder: this.holder, ttlMs: this.leaseMs });
      result.claimed = wakes.length;
      for (const wake of wakes) {
        const job = store.getJobTrusted(wake.jobId);
        let delivered;
        try { delivered = job ? await this.onWake(wake, job) : { ok: false, error: "JOB_NOT_FOUND" }; }
        catch (error) { delivered = { ok: false, error: error?.message || String(error) }; }
        if (delivered?.ok) {
          if (store.completeWake(wake.id, { holder: this.holder, fencingEpoch: wake.fencingEpoch }).ok) result.delivered += 1;
        } else if (delivered?.permanent || wake.attemptCount >= 100) {
          if (store.abandonWake(wake.id, {
            holder: this.holder, fencingEpoch: wake.fencingEpoch, error: delivered?.error,
          }).ok) result.abandoned += 1;
        } else {
          if (store.releaseWake(wake.id, {
            holder: this.holder, fencingEpoch: wake.fencingEpoch, error: delivered?.error,
          }).ok) result.released += 1;
        }
      }
      return result;
    } finally { store.close(); }
  }

  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      const reconciliation = await this.reconcileOnce();
      const wakes = await this.deliverWakesOnce();
      const store = this._store();
      let maintenance;
      try {
        maintenance = store.pruneTerminal();
        for (const job of maintenance.prunedJobs) {
          for (const file of [job.stdoutPath, job.stderrPath]) {
            if (file && path.dirname(file) === path.resolve(this.jobsDir)) {
              try { fs.unlinkSync(file); } catch { /* already absent or still locked */ }
            }
          }
        }
      } finally { store.close(); }
      maintenance.logs = enforceGlobalLogQuota(this.jobsDir);
      return { reconciliation, wakes, maintenance };
    })();
    try { return await this.running; } finally { this.running = null; }
  }

  handleResume() { return this._runSafely(); }

  _runSafely() {
    return this.runOnce().catch((error) => ({
      ok: false,
      error: error?.message || String(error),
    }));
  }

  start() {
    if (this.timer) return;
    void this._runSafely();
    this.timer = setInterval(() => void this._runSafely(), this.intervalMs);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { LongTaskSupervisor };
