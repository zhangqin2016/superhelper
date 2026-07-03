"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { latestWorkProgress } = require("../work-progress-protocol");

const DEFAULT_LOG_TAIL_BYTES = 64 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

function nowIso() {
  return new Date().toISOString();
}

function safeId(value = "") {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

function jobsDir(options = {}) {
  if (options.registryDir) return path.resolve(options.registryDir);
  if (process.env.LILY_PROCESS_JOBS_DIR) return path.resolve(process.env.LILY_PROCESS_JOBS_DIR);
  try {
    return require("../config").userDataPath("process-jobs");
  } catch {
    return path.join(os.tmpdir(), "lily-process-jobs");
  }
}

function registryPath(options = {}) {
  return path.join(jobsDir(options), "jobs.json");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readRegistry(options = {}) {
  const file = registryPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object"
      ? parsed
      : { version: 1, jobs: {} };
  } catch {
    return { version: 1, jobs: {} };
  }
}

function writeRegistry(registry, options = {}) {
  const file = registryPath(options);
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function fail(error, detail = {}) {
  return { ok: false, error, ...detail };
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function safeOutputFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 50);
}

function isoTimeMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function heartbeatAtForRecord(record = {}) {
  const latest = Math.max(
    isoTimeMs(record.startedAt),
    isoTimeMs(record.updatedAt),
    fileMtimeMs(record.stdoutPath),
    fileMtimeMs(record.stderrPath),
  );
  return latest > 0 ? new Date(latest).toISOString() : "";
}

function phaseFromProgress(progress = null) {
  if (!progress || typeof progress !== "object") return "";
  return String(progress.phase || progress.status || progress.event || progress.label || progress.domain || "").trim();
}

function isRecoverableState(status = "") {
  return status === "running" || status === "failed";
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function compactJob(record = {}) {
  const status = record.status || "unknown";
  return {
    jobId: record.jobId || "",
    pid: record.pid || null,
    status,
    state: status,
    command: record.command || "",
    args: Array.isArray(record.args) ? record.args : [],
    cwd: record.cwd || "",
    stdoutPath: record.stdoutPath || "",
    stderrPath: record.stderrPath || "",
    startedAt: record.startedAt || "",
    updatedAt: record.updatedAt || "",
    heartbeatAt: heartbeatAtForRecord(record),
    phase: record.phase || "",
    outputFiles: safeOutputFiles(record.outputFiles),
    error: record.error || null,
    recoverable: isRecoverableState(status),
    exitCode: record.exitCode ?? null,
    signal: record.signal || null,
    health: record.health || null,
  };
}

function withProgressObservability(payload = {}, progress = null) {
  const phase = phaseFromProgress(progress) || payload.phase || "";
  return {
    ...payload,
    phase,
    progress: progress || payload.progress || null,
  };
}

function updateObservedStatus(record = {}) {
  if (!record.pid) return { ...record, status: record.status || "unknown", updatedAt: nowIso() };
  if (record.status === "stopped" || record.status === "exited" || record.status === "failed") return record;
  return {
    ...record,
    status: isPidAlive(record.pid) ? "running" : "exited",
    updatedAt: nowIso(),
  };
}

function findJob(jobId, options = {}) {
  const id = safeId(jobId);
  const registry = readRegistry(options);
  const record = registry.jobs[id];
  if (!record) return { registry, id, record: null };
  const observed = updateObservedStatus(record);
  if (observed.status !== record.status || observed.updatedAt !== record.updatedAt) {
    registry.jobs[id] = observed;
    writeRegistry(registry, options);
  }
  return { registry, id, record: observed };
}

function readRange(file, { offset = null, tailBytes = DEFAULT_LOG_TAIL_BYTES } = {}) {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const start = Number.isFinite(Number(offset))
      ? Math.max(0, Math.min(size, Number(offset)))
      : Math.max(0, size - Math.max(1, Number(tailBytes || DEFAULT_LOG_TAIL_BYTES)));
    const length = Math.max(0, size - start);
    if (length === 0) return { path: file, text: "", offset: start, nextOffset: size, byteSize: size, truncated: false };
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return {
        path: file,
        text: buffer.toString("utf8"),
        offset: start,
        nextOffset: size,
        byteSize: size,
        truncated: start > 0 && offset == null,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { path: file, text: "", offset: 0, nextOffset: 0, byteSize: 0, truncated: false, error: err?.message || String(err) };
  }
}

function latestProgressForRecord(record = {}) {
  const stdout = readRange(record.stdoutPath, { tailBytes: DEFAULT_LOG_TAIL_BYTES }).text;
  const stderr = readRange(record.stderrPath, { tailBytes: DEFAULT_LOG_TAIL_BYTES }).text;
  return latestWorkProgress(`${stdout}\n${stderr}`);
}

function healthProcess(record) {
  return {
    ok: isPidAlive(record.pid),
    type: "process",
    detail: isPidAlive(record.pid) ? "process_alive" : "process_not_running",
  };
}

function healthTcp(check = {}) {
  return new Promise((resolve) => {
    const host = check.host || "127.0.0.1";
    const port = Number(check.port);
    if (!Number.isInteger(port) || port <= 0) {
      resolve({ ok: false, type: "tcp", detail: "port_required" });
      return;
    }
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, type: "tcp", detail: "timeout" });
    }, Number(check.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS));
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve({ ok: true, type: "tcp", detail: `${host}:${port}` });
    });
    socket.once("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, type: "tcp", detail: err?.code || err?.message || "connect_failed" });
    });
  });
}

function healthHttp(check = {}) {
  return new Promise((resolve) => {
    if (!check.url) {
      resolve({ ok: false, type: "http", detail: "url_required" });
      return;
    }
    let parsed;
    try {
      parsed = new URL(check.url);
    } catch {
      resolve({ ok: false, type: "http", detail: "invalid_url" });
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(parsed, { method: "GET", timeout: Number(check.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS) }, (res) => {
      res.resume();
      const min = Number(check.minStatus || 200);
      const max = Number(check.maxStatus || 399);
      resolve({ ok: res.statusCode >= min && res.statusCode <= max, type: "http", detail: `status_${res.statusCode}` });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, type: "http", detail: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, type: "http", detail: err?.code || err?.message || "request_failed" }));
    req.end();
  });
}

function healthLog(record, check = {}) {
  const needle = String(check.contains || "");
  if (!needle) return { ok: false, type: "log", detail: "contains_required" };
  const tailBytes = Number(check.tailBytes || DEFAULT_LOG_TAIL_BYTES);
  const stdout = readRange(record.stdoutPath, { tailBytes }).text;
  const stderr = readRange(record.stderrPath, { tailBytes }).text;
  const ok = stdout.includes(needle) || stderr.includes(needle);
  return { ok, type: "log", detail: ok ? "matched" : "not_found" };
}

async function evaluateHealth(record = {}, check = null) {
  const healthcheck = check || record.healthcheck || { type: "process" };
  const type = String(healthcheck.type || "process");
  if (type === "none") return { ok: true, type: "none", detail: "not_required" };
  if (type === "process") return healthProcess(record);
  if (type === "tcp") return healthTcp(healthcheck);
  if (type === "http") return healthHttp(healthcheck);
  if (type === "log") return healthLog(record, healthcheck);
  return { ok: false, type, detail: "unsupported_healthcheck" };
}

async function waitForHealth(record, healthcheck, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
  let last = await evaluateHealth(record, healthcheck);
  while (!last.ok && Date.now() < deadline) {
    if (record.pid && !isPidAlive(record.pid)) return { ok: false, type: last.type, detail: "process_exited_before_healthy" };
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await evaluateHealth(record, healthcheck);
  }
  return last;
}

async function startJob(input = {}, options = {}) {
  const command = String(input.command || "").trim();
  if (!command) return fail("COMMAND_REQUIRED");
  const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
  const cwd = path.resolve(String(input.cwd || process.cwd()));
  try {
    if (!fs.statSync(cwd).isDirectory()) return fail("CWD_NOT_DIRECTORY", { cwd });
  } catch (err) {
    return fail("CWD_UNAVAILABLE", { cwd, message: err?.message || String(err) });
  }

  const dir = jobsDir(options);
  ensureDir(dir);
  const jobId = safeId(input.jobId || `job_${crypto.randomUUID()}`);
  const stdoutPath = path.resolve(input.stdoutPath || path.join(dir, `${jobId}.stdout.log`));
  const stderrPath = path.resolve(input.stderrPath || path.join(dir, `${jobId}.stderr.log`));
  ensureDir(path.dirname(stdoutPath));
  ensureDir(path.dirname(stderrPath));

  const outFd = fs.openSync(stdoutPath, "a");
  const errFd = fs.openSync(stderrPath, "a");
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(input.env && typeof input.env === "object" ? input.env : {}) },
      shell: input.shell === undefined ? args.length === 0 : input.shell,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return fail("SPAWN_FAILED", { message: err?.message || String(err) });
  }
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  child.unref();
  const record = {
    jobId,
    pid: child.pid || null,
    status: child.pid ? "running" : "failed",
    command,
    args,
    cwd,
    stdoutPath,
    stderrPath,
    outputFiles: safeOutputFiles(input.outputFiles),
    startedAt: nowIso(),
    updatedAt: nowIso(),
    exitCode: null,
    signal: null,
    healthcheck: input.healthcheck || { type: "process" },
    health: null,
  };
  const registry = readRegistry(options);
  registry.jobs[jobId] = record;
  writeRegistry(registry, options);

  child.once("exit", (code, signal) => {
    const latest = readRegistry(options);
    const current = latest.jobs[jobId];
    if (!current) return;
    latest.jobs[jobId] = {
      ...current,
      status: code === 0 ? "exited" : "failed",
      exitCode: code,
      signal: signal || null,
      updatedAt: nowIso(),
    };
    try { writeRegistry(latest, options); } catch { /* best effort */ }
  });
  child.once("error", (err) => {
    const latest = readRegistry(options);
    const current = latest.jobs[jobId];
    if (!current) return;
    latest.jobs[jobId] = {
      ...current,
      status: "failed",
      error: err?.message || String(err),
      updatedAt: nowIso(),
    };
    try { writeRegistry(latest, options); } catch { /* best effort */ }
  });

  const waitMs = Number(input.waitForHealthMs || 0);
  const health = waitMs > 0
    ? await waitForHealth(record, record.healthcheck, waitMs)
    : await evaluateHealth(record, record.healthcheck);
  const afterHealth = readRegistry(options);
  if (afterHealth.jobs[jobId]) {
    afterHealth.jobs[jobId].health = health;
    afterHealth.jobs[jobId].updatedAt = nowIso();
    writeRegistry(afterHealth, options);
  }
  const progress = latestProgressForRecord({ ...record, health });
  return { ok: true, ...withProgressObservability(compactJob({ ...record, health }), progress), health };
}

async function statusJob(input = {}, options = {}) {
  const found = findJob(input.jobId, options);
  if (!found.record) return fail("JOB_NOT_FOUND", { jobId: safeId(input.jobId) });
  const health = await evaluateHealth(found.record, input.healthcheck || found.record.healthcheck);
  found.registry.jobs[found.id] = { ...found.record, health, updatedAt: nowIso() };
  writeRegistry(found.registry, options);
  const progress = latestProgressForRecord(found.registry.jobs[found.id]);
  return {
    ok: true,
    ...withProgressObservability(compactJob(found.registry.jobs[found.id]), progress),
    alive: isPidAlive(found.record.pid),
    stdoutBytes: fileSize(found.record.stdoutPath),
    stderrBytes: fileSize(found.record.stderrPath),
    progress,
  };
}

function logsJob(input = {}, options = {}) {
  const found = findJob(input.jobId, options);
  if (!found.record) return fail("JOB_NOT_FOUND", { jobId: safeId(input.jobId) });
  const tailBytes = Number(input.tailBytes || DEFAULT_LOG_TAIL_BYTES);
  return {
    ok: true,
    jobId: found.id,
    ...withProgressObservability(compactJob(found.record), latestProgressForRecord(found.record)),
    stdout: readRange(found.record.stdoutPath, { offset: input.stdoutOffset, tailBytes }),
    stderr: readRange(found.record.stderrPath, { offset: input.stderrOffset, tailBytes }),
    progress: latestProgressForRecord(found.record),
  };
}

async function stopJob(input = {}, options = {}) {
  const found = findJob(input.jobId, options);
  if (!found.record) return fail("JOB_NOT_FOUND", { jobId: safeId(input.jobId) });
  const pid = Number(found.record.pid);
  if (!isPidAlive(pid)) {
    found.registry.jobs[found.id] = { ...found.record, status: "exited", updatedAt: nowIso() };
    writeRegistry(found.registry, options);
    return { ok: true, stopped: true, alreadyExited: true, ...compactJob(found.registry.jobs[found.id]) };
  }
  const signal = input.signal || "SIGTERM";
  try {
    process.kill(pid, signal);
  } catch (err) {
    return fail("STOP_FAILED", { jobId: found.id, pid, message: err?.message || String(err) });
  }
  const deadline = Date.now() + Number(input.timeoutMs || DEFAULT_STOP_TIMEOUT_MS);
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isPidAlive(pid) && input.force !== false) {
    try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ }
  }
  const stopped = !isPidAlive(pid);
  found.registry.jobs[found.id] = {
    ...found.record,
    status: stopped ? "stopped" : "running",
    signal: stopped ? signal : null,
    updatedAt: nowIso(),
  };
  writeRegistry(found.registry, options);
  return { ok: stopped, stopped, ...compactJob(found.registry.jobs[found.id]) };
}

function listJobs(input = {}, options = {}) {
  const registry = readRegistry(options);
  const jobs = Object.values(registry.jobs)
    .map(updateObservedStatus)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, Number(input.limit || 50))
    .map(compactJob);
  registry.jobs = Object.fromEntries(jobs.map((job) => [job.jobId, { ...(registry.jobs[job.jobId] || {}), ...job }]));
  writeRegistry(registry, options);
  return { ok: true, jobs };
}

module.exports = {
  evaluateHealth,
  jobsDir,
  listJobs,
  logsJob,
  readRegistry,
  registryPath,
  startJob,
  statusJob,
  stopJob,
};
