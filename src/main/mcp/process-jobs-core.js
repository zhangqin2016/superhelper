"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const jsonFile = require("../json-file");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { isHostNoiseOnlyFile, jobWorkEvidence, withoutHostNoise } = require("./job-observation");
const { stopRecordedProcess, terminateProcessGroup } = require("../process-tree-kill");
const { captureProcessIdentity } = require("../long-task/process-identity");
const { createJobHealthProbes } = require("./process-job-health");
const { latestWorkProgress } = require("../work-progress-protocol");
const { sameJobGeneration, updateJobGeneration } = require("./process-job-generation").createJobGenerationGuard({ readRegistry, writeRegistry });

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
  jsonFile.writeJson(registryPath(options), registry, { newline: true });
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

function xmlUnescape(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractGeneratedMediaOutputFiles(text = "") {
  const files = [];
  const raw = String(text || "");
  for (const blockMatch of raw.matchAll(/<generated_media\b[\s\S]*?<\/generated_media>/g)) {
    const block = blockMatch[0];
    for (const fileMatch of block.matchAll(/<file\b[^>]*\bpath=(["'])(.*?)\1/gs)) {
      const file = xmlUnescape(fileMatch[2]).trim();
      if (file) files.push(file);
    }
  }
  return [...new Set(files)].slice(0, 50);
}

function observedOutputFiles(record = {}) {
  const existing = safeOutputFiles(record.outputFiles);
  const stdout = readRange(record.stdoutPath, { tailBytes: DEFAULT_LOG_TAIL_BYTES }).text;
  const stderr = readRange(record.stderrPath, { tailBytes: DEFAULT_LOG_TAIL_BYTES }).text;
  return [...new Set([
    ...existing,
    ...extractGeneratedMediaOutputFiles(stdout),
    ...extractGeneratedMediaOutputFiles(stderr),
  ])].slice(0, 50);
}

function withObservedOutputFiles(record = {}) {
  const outputFiles = observedOutputFiles(record);
  if (JSON.stringify(outputFiles) === JSON.stringify(safeOutputFiles(record.outputFiles))) return record;
  return { ...record, outputFiles };
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

const { evaluateHealth } = createJobHealthProbes({
  isPidAlive,
  readRange,
  logTailBytes: DEFAULT_LOG_TAIL_BYTES,
  timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
  http: require("node:http"),
  https: require("node:https"),
  net: require("node:net"),
});

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

async function startLegacyJob(input = {}, options = {}) {
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
    child = require("../collaboration/foreground-writer").spawnForeground(command, args, {
      cwd,
      env: { ...process.env, ...(input.env && typeof input.env === "object" ? input.env : {}) },
      shell: input.shell === undefined ? args.length === 0 : input.shell,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    },{filePath:options.writerLockPath,deferLaunch:true});
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return fail("SPAWN_FAILED", { message: err?.message || String(err) });
  }
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  child.unref();
  const processIdentity=process.platform!=="win32"?captureProcessIdentity(child.pid,{processGroupId:child.pid}):null;
  if(process.platform!=="win32"&&!processIdentity){
    await terminateProcessGroup(child);
    return fail("PROCESS_IDENTITY_UNAVAILABLE");
  }
  // Capture the wrapper identity while it is still waiting for stdin, so even
  // a command that exits immediately retains a verifiable stop identity.
  child.startForeground?.();
  const record = {
    jobId,
    generationId: crypto.randomUUID(),
    pid: child.pid || null,
    processIdentity,
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
    try {
      updateJobGeneration(record, (current) => ({
        ...current,
        status: code === 0 ? "exited" : "failed",
        exitCode: code,
        signal: signal || null,
        updatedAt: nowIso(),
      }), options);
    } catch { /* best effort */ }
  });
  child.once("error", (err) => {
    try {
      updateJobGeneration(record, (current) => ({
        ...current,
        status: "failed",
        error: err?.message || String(err),
        updatedAt: nowIso(),
      }), options);
    } catch { /* best effort */ }
  });

  const waitMs = Number(input.waitForHealthMs || 0);
  const health = waitMs > 0
    ? await waitForHealth(record, record.healthcheck, waitMs)
    : await evaluateHealth(record, record.healthcheck);
  updateJobGeneration(record, (current) => ({ ...current, health, updatedAt: nowIso() }), options);
  const progress = latestProgressForRecord({ ...record, health });
  return { ok: true, ...withProgressObservability(compactJob({ ...record, health }), progress), health };
}

async function statusLegacyJob(input = {}, options = {}) {
  const found = findJob(input.jobId, options);
  if (!found.record) return fail("JOB_NOT_FOUND", { jobId: safeId(input.jobId) });
  const health = await evaluateHealth(found.record, input.healthcheck || found.record.healthcheck);
  const observed = updateJobGeneration(found.record,
    (current) => withObservedOutputFiles({ ...current, health, updatedAt: nowIso() }), options);
  if (!observed) return fail("JOB_REPLACED", { jobId: found.id });
  const progress = latestProgressForRecord(observed);
  return {
    ok: true,
    ...withProgressObservability(compactJob(observed), progress),
    alive: isPidAlive(found.record.pid),
    stdoutBytes: fileSize(found.record.stdoutPath),
    stderrBytes: fileSize(found.record.stderrPath),
    stderrHostNoiseOnly: isHostNoiseOnlyFile(found.record.stderrPath, { readRange, fileSize, tailBytes: DEFAULT_LOG_TAIL_BYTES }),
    ...jobWorkEvidence({ progress, outputFiles: observed.outputFiles }),
    progress,
  };
}

function logsLegacyJob(input = {}, options = {}) {
  const found = findJob(input.jobId, options);
  if (!found.record) return fail("JOB_NOT_FOUND", { jobId: safeId(input.jobId) });
  const tailBytes = Number(input.tailBytes || DEFAULT_LOG_TAIL_BYTES);
  const observed = withObservedOutputFiles(found.record);
  if (observed !== found.record) {
    found.registry.jobs[found.id] = observed;
    writeRegistry(found.registry, options);
  }
  return {
    ok: true,
    jobId: found.id,
    ...withProgressObservability(compactJob(observed), latestProgressForRecord(observed)),
    stdout: readRange(observed.stdoutPath, { offset: input.stdoutOffset, tailBytes }),
    // Host noise is not the job's output. The log file itself is untouched.
    stderr: withoutHostNoise(readRange(observed.stderrPath, { offset: input.stderrOffset, tailBytes })),
    progress: latestProgressForRecord(observed),
  };
}

async function stopLegacyJob(input = {}, options = {}) {
  const found = findJob(input.jobId, options);
  if (!found.record) return fail("JOB_NOT_FOUND", { jobId: safeId(input.jobId) });
  const pid = Number(found.record.pid);
  const signal = input.signal || "SIGTERM";
  const group = found.record.processIdentity || null;
  // A POSIX job is its own process group, so both liveness and the signal target
  // the group. Windows has no group semantics and the recorded pid is usually the
  // cmd.exe wrapper, which the guard tree-kills instead.
  const alive = () => {
    if (!group) return isPidAlive(pid);
    try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  };
  const stop = (sig) => stopRecordedProcess({ pid, identity: group, signal: sig, tree: Boolean(group) });
  // A refusal means the recorded pid is not this job's process any more: a changed
  // identity is reported as such, and anything else (a reused pid that is now one
  // of ours) means the job is simply over.
  const term = alive() ? stop(signal) : { ok: false, error: "EXITED" };
  if (!term.ok && term.error === "SIGNAL_FAILED") return fail("STOP_FAILED", { jobId: found.id, pid, message: term.message });
  if (!term.ok && term.error === "IDENTITY_MISMATCH") return fail("PROCESS_IDENTITY_CHANGED", { jobId: found.id });
  if (!term.ok) {
    found.registry.jobs[found.id] = { ...found.record, status: "exited", updatedAt: nowIso() };
    writeRegistry(found.registry, options);
    return { ok: true, stopped: true, alreadyExited: true, ...compactJob(found.registry.jobs[found.id]) };
  }
  const deadline = Date.now() + Number(input.timeoutMs || DEFAULT_STOP_TIMEOUT_MS);
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const latest = readRegistry(options);
  if (!sameJobGeneration(latest.jobs[found.id], found.record)) return fail("JOB_REPLACED", { jobId: found.id });
  if (alive() && input.force !== false) {
    const kill = stop("SIGKILL");
    if (!kill.ok && kill.error === "IDENTITY_MISMATCH") return fail("PROCESS_IDENTITY_CHANGED", { jobId: found.id });
    const killDeadline = Date.now() + 2_000;
    while (alive() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stopped = !alive();
  latest.jobs[found.id] = {
    ...latest.jobs[found.id],
    status: stopped ? "stopped" : "running",
    signal: stopped ? signal : null,
    updatedAt: nowIso(),
  };
  writeRegistry(latest, options);
  return { ok: stopped, stopped, ...compactJob(latest.jobs[found.id]) };
}

function listLegacyJobs(input = {}, options = {}) {
  const registry = readRegistry(options);
  const jobs = Object.values(registry.jobs)
    .map(updateObservedStatus)
    .map(withObservedOutputFiles)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, Number(input.limit || 50))
    .map(compactJob);
  registry.jobs = Object.fromEntries(jobs.map((job) => [job.jobId, { ...(registry.jobs[job.jobId] || {}), ...job }]));
  writeRegistry(registry, options);
  return { ok: true, jobs };
}

const dispatched = require("../long-task/process-jobs-dispatch").createProcessJobDispatch({
  evaluateHealth,
  legacy: { start: startLegacyJob, status: statusLegacyJob, logs: logsLegacyJob, stop: stopLegacyJob, list: listLegacyJobs },
});
const { startJob, statusJob, logsJob, stopJob, listJobs } = dispatched;

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
