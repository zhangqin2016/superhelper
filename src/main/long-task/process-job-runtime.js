"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { LongTaskStore, TERMINAL_LONG_TASK_STATUSES } = require("./store");
const { verifyProcessJobScope } = require("./turn-scope");
const { matchesProcessIdentity } = require("./process-identity");
const { enforceLogQuota } = require("./log-policy");
const { latestWorkProgress } = require("../work-progress-protocol");
const { stopPidTree } = require("../process-tree-kill");
const { ensureLaunchDiskSpace } = require("./disk-policy");

const TERMINAL = TERMINAL_LONG_TASK_STATUSES;
const HOLDER = `process-jobs:${process.pid}`;
const LEASE_MS = 3_000;

function fail(error, detail = {}) { return { ok: false, error, ...detail }; }
function safeId(value) { return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
async function waitForJson(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = readJson(file);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return null;
}
function fileSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }
function boundedStartInput(input, cwd) {
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  if (args.length > 256 || args.some((arg) => Buffer.byteLength(arg, "utf8") > 8_192)) {
    return { ok: false, error: "ARGS_TOO_LARGE" };
  }
  const env = input.env && typeof input.env === "object" && !Array.isArray(input.env) ? input.env : {};
  const envEntries = Object.entries(env).map(([key, value]) => [String(key), String(value)]);
  if (envEntries.length > 256 || envEntries.some(([key, value]) => key.length > 256 || Buffer.byteLength(value, "utf8") > 16_384)) {
    return { ok: false, error: "ENV_TOO_LARGE" };
  }
  const outputFiles = Array.isArray(input.outputFiles)
    ? input.outputFiles.map((file) => path.resolve(cwd, String(file))).slice(0, 50)
    : [];
  if (outputFiles.some((file) => Buffer.byteLength(file, "utf8") > 8_192)) {
    return { ok: false, error: "OUTPUT_PATH_TOO_LARGE" };
  }
  return { ok: true, args, env: Object.fromEntries(envEntries), outputFiles };
}
function readTail(file, tailBytes = 64 * 1024, offset = null) {
  try {
    const size = fs.statSync(file).size;
    const start = Number.isFinite(Number(offset)) ? Math.min(size, Math.max(0, Number(offset))) : Math.max(0, size - tailBytes);
    const fd = fs.openSync(file, "r");
    try {
      const out = Buffer.alloc(size - start);
      fs.readSync(fd, out, 0, out.length, start);
      return { path: file, text: out.toString("utf8"), offset: start, nextOffset: size, byteSize: size, truncated: start > 0 && offset == null };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    return { path: file, text: "", offset: 0, nextOffset: 0, byteSize: 0, truncated: false, error: error?.message || String(error) };
  }
}

class DurableProcessJobRuntime {
  constructor(options = {}) {
    this.secret = options.secret;
    this.dbPath = options.dbPath;
    this.jobsDir = options.jobsDir || path.join(path.dirname(this.dbPath), "process-jobs");
    this.evaluateHealth = options.evaluateHealth || (async (job) => ({ ok: this._alive(job), type: "process", detail: this._alive(job) ? "process_alive" : "process_not_running" }));
    this.now = options.now || Date.now;
  }

  _authorize(input, operation) {
    return verifyProcessJobScope(input, { secret: this.secret, operation, now: this.now });
  }

  _store() { return new LongTaskStore({ filePath: this.dbPath, now: this.now }); }
  _marker(job) { return path.join(this.jobsDir, `${job.id}.terminal.json`); }
  _alive(job) {
    if (job.processIdentity?.reconnectSafe === false) {
      const heartbeat = readJson(job.processIdentity.heartbeatPath);
      return Boolean(
        heartbeat
        && heartbeat.launchNonce === job.processIdentity.launchNonce
        && Date.now() - Number(heartbeat.observedAt || 0) < 10_000
      );
    }
    return matchesProcessIdentity(job.processIdentity);
  }

  _compact(job, extra = {}) {
    return {
      jobId: job.id, pid: job.pid, status: job.status, state: job.status,
      command: job.command, args: job.args, cwd: job.cwd,
      stdoutPath: job.stdoutPath, stderrPath: job.stderrPath,
      startedAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(),
      heartbeatAt: job.lastProgressAt ? new Date(job.lastProgressAt).toISOString() : "",
      phase: job.progress?.phase || job.progress?.label || "", progress: job.progress,
      outputFiles: job.outputFiles, error: job.error, recoverable: !TERMINAL.has(job.status),
      exitCode: job.exitCode, signal: job.signal, ...extra,
    };
  }

  _scopeJob(store, authorized, jobId) {
    return store.getJob(authorized.scope, safeId(jobId));
  }

  _claim(store, scope, job) {
    if (TERMINAL.has(job.status)) return { ok: true, job };
    return store.claimLease(scope, job.id, { holder: HOLDER, ttlMs: LEASE_MS });
  }

  _reconcile(store, scope, job) {
    if (TERMINAL.has(job.status)) return job;
    const claimed = this._claim(store, scope, job);
    if (!claimed.ok) return claimed.job || job;
    job = claimed.job;
    enforceLogQuota(job.stdoutPath);
    enforceLogQuota(job.stderrPath);
    const stdout = readTail(job.stdoutPath).text;
    const stderr = readTail(job.stderrPath).text;
    const progress = latestWorkProgress(`${stdout}\n${stderr}`);
    const seq = fileSize(job.stdoutPath) + fileSize(job.stderrPath);
    if (progress && JSON.stringify(progress) !== JSON.stringify(job.progress)) {
      const advanced = store.recordProgress(scope, job.id, {
        holder: HOLDER, fencingEpoch: job.fencingEpoch, progressSeq: job.progressSeq + 1, progress,
      });
      if (advanced.ok) job = advanced.job;
    }
    const marker = readJson(this._marker(job));
    if (marker && marker.launchNonce === job.processIdentity?.launchNonce) {
      const status = marker.exitCode === 0 ? "succeeded" : "failed";
      const terminal = store.markTerminal(scope, job.id, {
        holder: HOLDER, fencingEpoch: job.fencingEpoch, status,
        exitCode: marker.exitCode, signal: marker.signal, error: marker.error,
      });
      return terminal.job || job;
    }
    if (!this._alive(job)) {
      const terminal = store.markTerminal(scope, job.id, {
        holder: HOLDER, fencingEpoch: job.fencingEpoch, status: "outcome_unknown",
        error: "PROCESS_EXITED_WITHOUT_TERMINAL_MARKER",
      });
      return terminal.job || job;
    }
    const observed = store.observe(scope, job.id, { holder: HOLDER, fencingEpoch: job.fencingEpoch });
    return observed.job || job;
  }

  async start(input = {}) {
    const auth = this._authorize(input, "start");
    if (!auth.ok) return auth;
    const command = String(input.command || "").trim();
    if (!command) return fail("COMMAND_REQUIRED");
    const cwd = path.resolve(String(input.cwd || process.cwd()));
    try { if (!fs.statSync(cwd).isDirectory()) return fail("CWD_NOT_DIRECTORY", { cwd }); } catch { return fail("CWD_UNAVAILABLE", { cwd }); }
    fs.mkdirSync(this.jobsDir, { recursive: true });
    const disk = ensureLaunchDiskSpace(this.jobsDir);
    if (!disk.ok) return fail(disk.error, { availableBytes: disk.availableBytes, minFreeBytes: disk.minFreeBytes });
    const bounded = boundedStartInput(input, cwd);
    if (!bounded.ok) return fail(bounded.error);
    const jobId = safeId(input.jobId || `job_${crypto.randomUUID()}`);
    const idempotencyKey = String(input.idempotencyKey || `${auth.scope.turnId}:${jobId}`).slice(0, 240);
    const store = this._store();
    try {
      let job = store.createJob({
        id: jobId, scope: auth.scope, command,
        args: bounded.args, cwd,
        replayPolicy: input.replayPolicy || "never", idempotencyKey,
        outputFiles: bounded.outputFiles,
      });
      if (job.id !== jobId || job.pid || job.leaseHolder || TERMINAL.has(job.status)) return { ok: true, duplicate: true, ...this._compact(job) };
      const lease = store.claimLease(auth.scope, job.id, { holder: HOLDER, ttlMs: LEASE_MS, allowRenew: false });
      if (!lease.ok) {
        if (["LEASE_HELD", "CAS_RETRY"].includes(lease.error)) {
          const original = store.getJob(auth.scope, job.id) || job;
          return { ok: true, duplicate: true, ...this._compact(original) };
        }
        return fail(lease.error);
      }
      job = lease.job;
      const stdoutPath = path.join(this.jobsDir, `${job.id}.stdout.log`);
      const stderrPath = path.join(this.jobsDir, `${job.id}.stderr.log`);
      const specPath = path.join(this.jobsDir, `${job.id}.launch.json`);
      const startMarkerPath = path.join(this.jobsDir, `${job.id}.started.json`);
      const heartbeatPath = path.join(this.jobsDir, `${job.id}.heartbeat.json`);
      const markerPath = this._marker(job);
      const launchNonce = crypto.randomBytes(24).toString("base64url");
      fs.writeFileSync(specPath, `${JSON.stringify({
        command, args: job.args, cwd, env: bounded.env, shell: input.shell === undefined ? job.args.length === 0 : input.shell,
        markerPath, startMarkerPath, heartbeatPath, launchNonce,
      })}\n`, { encoding: "utf8", mode: 0o600 });
      const outFd = fs.openSync(stdoutPath, "a");
      const errFd = fs.openSync(stderrPath, "a");
      let child;
      try {
        const launcherEnv = { ...process.env, LILY_LONG_TASK_LAUNCH_NONCE: launchNonce };
        delete launcherEnv.LILY_PROCESS_JOBS_SCOPE_SECRET;
        child = spawn(process.execPath, [path.join(__dirname, "worker-bootstrap.js"), specPath], {
          cwd, env: launcherEnv,
          detached: true, stdio: ["ignore", outFd, errFd], windowsHide: true,
        });
      } finally {
        fs.closeSync(outFd); fs.closeSync(errFd);
      }
      child.unref();
      const capturedIdentity = await waitForJson(startMarkerPath);
      const identity = capturedIdentity ? { ...capturedIdentity, observerPid: process.pid } : null;
      if (!identity) {
        try { stopPidTree(child.pid, "SIGKILL"); } catch { /* best effort */ }
        return fail("PROCESS_IDENTITY_UNAVAILABLE");
      }
      const attached = store.attachProcess(auth.scope, job.id, {
        holder: HOLDER, fencingEpoch: job.fencingEpoch, pid: identity.pid,
        processIdentity: identity, stdoutPath, stderrPath,
      });
      if (!attached.ok) return fail(attached.error);
      job = attached.job;
      const healthDeadline = Date.now() + Math.max(0, Math.min(Number(input.waitForHealthMs) || 0, 120_000));
      let health;
      do {
        health = await this.evaluateHealth(job, input.healthcheck || { type: "process" });
        if (health?.ok || Date.now() >= healthDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
      return { ok: true, ...this._compact(job, { health }), health };
    } finally { store.close(); }
  }

  async status(input = {}) {
    const auth = this._authorize(input, "status");
    if (!auth.ok) return auth;
    const store = this._store();
    try {
      let job = this._scopeJob(store, auth, input.jobId);
      if (!job) return fail("JOB_NOT_FOUND");
      job = this._reconcile(store, auth.scope, job);
      const alive = !TERMINAL.has(job.status) && this._alive(job);
      return { ok: true, ...this._compact(job), alive, stdoutBytes: fileSize(job.stdoutPath), stderrBytes: fileSize(job.stderrPath) };
    } finally { store.close(); }
  }

  logs(input = {}) {
    const auth = this._authorize(input, "logs");
    if (!auth.ok) return auth;
    const store = this._store();
    try {
      let job = this._scopeJob(store, auth, input.jobId);
      if (!job) return fail("JOB_NOT_FOUND");
      job = this._reconcile(store, auth.scope, job);
      const tail = Math.max(1, Math.min(Number(input.tailBytes) || 64 * 1024, 1_000_000));
      return { ok: true, ...this._compact(job), stdout: readTail(job.stdoutPath, tail, input.stdoutOffset), stderr: readTail(job.stderrPath, tail, input.stderrOffset) };
    } finally { store.close(); }
  }

  list(input = {}) {
    const auth = this._authorize(input, "list");
    if (!auth.ok) return auth;
    const store = this._store();
    try { return { ok: true, jobs: store.listJobs(auth.scope, { limit: input.limit }).map((job) => this._compact(job)) }; }
    finally { store.close(); }
  }

  async stop(input = {}) {
    const auth = this._authorize(input, "stop");
    if (!auth.ok) return auth;
    const store = this._store();
    try {
      let job = this._scopeJob(store, auth, input.jobId);
      if (!job) return fail("JOB_NOT_FOUND");
      job = this._reconcile(store, auth.scope, job);
      if (TERMINAL.has(job.status)) return { ok: true, stopped: true, alreadyExited: true, ...this._compact(job) };
      const claim = this._claim(store, auth.scope, job);
      if (!claim.ok) return fail(claim.error);
      job = claim.job;
      const signal = input.signal || "SIGTERM";
      const error = stopPidTree(job.pid, signal);
      if (error) return fail("STOP_FAILED", { message: error.message });
      const deadline = Date.now() + Math.max(100, Math.min(Number(input.timeoutMs) || 5_000, 60_000));
      while (this._alive(job) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (this._alive(job) && input.force !== false) stopPidTree(job.pid, "SIGKILL");
      const terminal = store.markTerminal(auth.scope, job.id, {
        holder: HOLDER, fencingEpoch: job.fencingEpoch, status: "cancelled", signal,
      });
      return { ok: terminal.ok, stopped: terminal.ok, ...this._compact(terminal.job || job) };
    } finally { store.close(); }
  }
}

module.exports = { DurableProcessJobRuntime };
