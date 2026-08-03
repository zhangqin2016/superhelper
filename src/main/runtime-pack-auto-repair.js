"use strict";

const path = require("node:path");
const os = require("node:os");
const { fork } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function startRuntimePackAutoRepair(options = {}) {
  const forkImpl = options.forkImpl || fork;
  const workerPath = options.workerPath || path.join(__dirname, "runtime-pack-auto-repair-worker.js");
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const basePaths = options.basePaths || {};
  const child = forkImpl(workerPath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(basePaths.userData ? { LILY_USER_DATA_DIR: basePaths.userData } : {}),
      ...(basePaths.home ? { LILY_HOME: basePaths.home } : {}),
      ...(basePaths.documents ? { LILY_DOCUMENTS_DIR: basePaths.documents } : {}),
      ...(typeof options.isPackaged === "boolean" ? { LILY_IS_PACKAGED: options.isPackaged ? "1" : "0" } : {}),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  try {
    const setPriority = options.setPriority || os.setPriority;
    const priority = Number.isInteger(options.backgroundPriority)
      ? options.backgroundPriority
      : os.constants.priority.PRIORITY_LOW;
    if (Number.isInteger(child.pid)) setPriority(child.pid, priority);
  } catch {
    // Priority lowering is best-effort; isolation in the worker still applies.
  }
  let settled = false;
  let stderr = "";
  let timer = null;
  let resolvePromise = null;
  let rejectPromise = null;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectPromise(error);
    else resolvePromise(result);
  };

  timer = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch {}
    finish(new Error(`Runtime-pack auto-repair timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.on("message", (message) => {
    if (message?.type === "runtime-pack-auto-repair-result") finish(null, message.result);
    if (message?.type === "runtime-pack-auto-repair-error") {
      finish(new Error(message.error || "Runtime-pack auto-repair failed"));
    }
  });
  child.on("error", (error) => finish(error));
  child.on("exit", (code, signal) => {
    if (settled) return;
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    finish(new Error(`Runtime-pack auto-repair worker exited before reporting (${code ?? signal ?? "unknown"})${detail}`));
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      try { child.kill("SIGTERM"); } catch {}
      finish(new Error("Runtime-pack auto-repair cancelled"));
    },
  };
}

function scheduleRuntimePackAutoRepair(options = {}) {
  const scheduleTimeout = options.scheduleTimeout || setTimeout;
  const cancelTimeout = options.cancelTimeout || clearTimeout;
  const initialDelayMs = Number(options.initialDelayMs) || 60_000;
  const retryDelayMs = Number(options.retryDelayMs) || 30_000;
  let timer = null;
  let repair = null;
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    if (error) rejectPromise(error);
    else resolvePromise(result);
  };
  const schedule = (delay) => {
    timer = scheduleTimeout(attempt, delay);
    timer?.unref?.();
  };
  const attempt = () => {
    timer = null;
    let idle = false;
    try { idle = options.isIdle?.() !== false; } catch { idle = false; }
    if (!idle) {
      schedule(retryDelayMs);
      return;
    }
    try {
      repair = options.startRepair();
      Promise.resolve(repair?.promise).then(
        (result) => finish(null, result),
        (error) => finish(error),
      );
    } catch (error) {
      finish(error);
    }
  };

  schedule(initialDelayMs);
  return {
    promise,
    cancel() {
      if (settled) return;
      if (timer) cancelTimeout(timer);
      timer = null;
      repair?.cancel?.();
      finish(null, { ok: true, cancelled: true, results: [] });
    },
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  scheduleRuntimePackAutoRepair,
  startRuntimePackAutoRepair,
};
