"use strict";

const { spawn } = require("node:child_process");

// Reap a process's WHOLE tree, not just the process itself. Engine/job
// children spawn tool children of their own (node/python/ripgrep/playwright);
// a plain child.kill("SIGTERM") on Windows is a single-process
// TerminateProcess, so those children survive, keep running, and hold locks
// on install/userData dirs — which is exactly what blocks the Windows updater
// ("could not be closed") and keeps ports occupied after "stop".
//   - Windows: taskkill /T /F kills the pid + its descendants.
//   - POSIX: the child is spawned detached (its own process group), so
//     kill(-pid) signals the whole group; SIGTERM then a SIGKILL fallback.
function killProcessTree(child, deps = {}) {
  if (!child || child.pid == null) return null;
  const pid = child.pid;
  const platform = deps.platform || process.platform;
  const spawnFn = deps.spawn || spawn;
  const killFn = deps.kill || ((target, signal) => process.kill(target, signal));
  if (platform === "win32") {
    // An unhandled 'error' on the fire-and-forget taskkill child would CRASH
    // the main process (unhandled 'error' events throw) — worst case exactly
    // on the before-quit path. Sink it and fall back to a plain kill.
    try {
      spawnFn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        ?.on?.("error", () => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
    } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    return null;
  }
  const killGroup = (signal) => {
    try { killFn(-pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
  };
  killGroup("SIGTERM");
  const hard = setTimeout(() => killGroup("SIGKILL"), deps.hardKillDelayMs ?? 2000);
  hard.unref?.();
  return hard;
}

// Fire-and-forget tree kill by bare pid, for job registries that recorded a
// pid instead of a ChildProcess. Windows has no signal semantics and the
// recorded pid is usually the cmd.exe wrapper of a shell command — killing it
// alone orphans the real worker (python/node server) which keeps its port.
function killPidTreeBestEffort(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  const spawnFn = deps.spawn || spawn;
  const killFn = deps.kill || ((target, signal) => process.kill(target, signal));
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return;
  if (platform === "win32") {
    try {
      spawnFn("taskkill", ["/pid", String(numericPid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        ?.on?.("error", () => { try { killFn(numericPid, "SIGKILL"); } catch { /* gone */ } });
    } catch { try { killFn(numericPid, "SIGKILL"); } catch { /* gone */ } }
    return;
  }
  try { killFn(numericPid, deps.signal || "SIGTERM"); } catch { /* already gone */ }
}

// Stop a recorded pid: signal semantics on POSIX (returns the kill error or
// null), whole-tree best-effort kill on Windows (always null — taskkill
// reports asynchronously and the caller's alive-poll confirms the result).
function stopPid(pid, signal = "SIGTERM", deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === "win32") {
    killPidTreeBestEffort(pid, { ...deps, platform });
    return null;
  }
  const killFn = deps.kill || ((target, nextSignal) => process.kill(target, nextSignal));
  try {
    killFn(Number(pid), signal);
    return null;
  } catch (err) {
    return err;
  }
}

// Process jobs are spawned detached, which gives POSIX jobs their own process
// group. Target that group so shell grandchildren and worker children cannot be
// orphaned. Windows keeps using taskkill /T for the equivalent tree semantics.
function stopPidTree(pid, signal = "SIGTERM", deps = {}) {
  const platform = deps.platform || process.platform;
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return new TypeError("invalid pid");
  if (platform === "win32") {
    killPidTreeBestEffort(numericPid, { ...deps, platform });
    return null;
  }
  const killFn = deps.kill || ((target, nextSignal) => process.kill(target, nextSignal));
  try {
    killFn(-numericPid, signal);
    return null;
  } catch (groupError) {
    try {
      killFn(numericPid, signal);
      return null;
    } catch {
      return groupError;
    }
  }
}

// The pids this app itself is made of: the main process, its parent, and every
// Electron child (renderers, GPU, utilities). A recorded job pid can never be
// one of these, whatever a registry says.
function ownProcessIds() {
  const pids = new Set([process.pid, process.ppid]);
  try {
    for (const metric of require("electron").app?.getAppMetrics?.() || []) pids.add(Number(metric.pid));
  } catch { /* not running under Electron */ }
  return pids;
}

/**
 * The ONLY way to signal a pid that was written down earlier (a job registry,
 * a session's task list) rather than held as a live ChildProcess.
 *
 * A pid is a name the OS reuses. A job that died without leaving a terminal
 * marker (crash, reboot, force quit) keeps its pid on record; when something
 * later "stops" it, that number can belong to anything — and after a reboot
 * on macOS it very plausibly belongs to one of this app's own renderer
 * helpers, which then dies with `killed · 15` and the customer sees "this
 * window could not load" (2026-09-20 field report). So before any signal:
 *   1. the pid must not be this app's own process tree (always enforced);
 *   2. when the record carries a process identity (start time + command
 *      fingerprint), the live process must still match it.
 * A refusal means "that process is already gone as far as this record is
 * concerned" — callers mark the job exited instead of signalling a stranger.
 *
 * @param {{ pid: number|string, identity?: object|null, signal?: string, tree?: boolean }} input
 * @returns {{ ok: true } | { ok: false, error: string, message?: string }}
 */
function stopRecordedProcess({ pid, identity = null, signal = "SIGTERM", tree = true } = {}, deps = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return { ok: false, error: "INVALID_PID" };
  const own = deps.ownPids ? new Set([...deps.ownPids()].map(Number)) : ownProcessIds();
  if (numericPid === process.pid || numericPid === process.ppid) return { ok: false, error: "SELF_PROCESS" };
  if (own.has(numericPid)) return { ok: false, error: "OWN_HELPER" };
  // An identity is binding only when it carries a fingerprint; an older record
  // without one is stopped as before, behind the own-process guard.
  if (identity && identity.fingerprint) {
    const matches = deps.matchesIdentity || require("./long-task/process-identity").matchesProcessIdentity;
    let ok = false;
    try { ok = matches(identity) === true; } catch { ok = false; }
    if (!ok) return { ok: false, error: "IDENTITY_MISMATCH" };
    if (Number(identity.pid) !== numericPid) return { ok: false, error: "IDENTITY_MISMATCH" };
  }
  const error = tree ? stopPidTree(numericPid, signal, deps) : stopPid(numericPid, signal, deps);
  if (error) return { ok: false, error: "SIGNAL_FAILED", message: error.message };
  return { ok: true };
}

// For owned detached POSIX children only. A dead leader can leave tool writers
// in its group, so confirmation probes the group, not just ChildProcess.exit.
// This does not prove that a tool which deliberately detached has stopped.
async function terminateProcessGroup(child, deps = {}) {
  if(!child)return {ok:true,scope:"not-started"};
  const pid=child.pid,platform=deps.platform||process.platform;
  if(!Number.isSafeInteger(pid)||pid<=1||pid===process.pid)return {ok:false,code:"PID_UNAVAILABLE"};
  const kill=deps.kill||((target,signal)=>process.kill(target,signal));
  const hard=killProcessTree(child,{...deps,platform,kill});
  if(platform==="win32")return {ok:false,code:"TREE_CONFIRMATION_UNAVAILABLE",pid};
  const deadline=Date.now()+(deps.timeoutMs??5000);
  let confirmed=false;
  try{
    for(;;){
      try{kill(-pid,0);}catch(error){
        if(error.code==="ESRCH"){confirmed=true;return {ok:true,scope:"process-group",pid};}
      }
      if(Date.now()>=deadline)return {ok:false,code:"EXIT_UNCONFIRMED",pid};
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }finally{if(confirmed&&hard)clearTimeout(hard);}
}

module.exports = { killProcessTree, killPidTreeBestEffort, ownProcessIds, stopPid, stopPidTree, stopRecordedProcess, terminateProcessGroup };
