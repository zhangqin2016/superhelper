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
function stopPid(pid, signal = "SIGTERM") {
  if (process.platform === "win32") {
    killPidTreeBestEffort(pid);
    return null;
  }
  try {
    process.kill(Number(pid), signal);
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

module.exports = { killProcessTree, killPidTreeBestEffort, stopPid, stopPidTree };
