#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function atomicJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function main() {
  const specPath = process.argv[2];
  if (!specPath) process.exit(125);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const identityTools = require("./process-identity");
  const identityInput = {
    command: spec.command,
    launchNonce: spec.launchNonce,
    processGroupId: process.pid,
  };
  const identity = identityTools.captureProcessIdentity(process.pid, identityInput)
    || identityTools.createWeakProcessIdentity(process.pid, identityInput);
  const heartbeatPath = spec.heartbeatPath;
  const writeHeartbeat = () => atomicJson(heartbeatPath, {
    version: 1,
    launchNonce: spec.launchNonce,
    launcherPid: process.pid,
    observedAt: Date.now(),
  });
  writeHeartbeat();
  const heartbeatTimer = setInterval(() => {
    try { writeHeartbeat(); } catch { /* terminal reconciliation remains authoritative */ }
  }, 2_000);
  heartbeatTimer.unref?.();
  atomicJson(spec.startMarkerPath, { ...identity, heartbeatPath });
  const env = { ...process.env, ...(spec.env || {}), LILY_LONG_TASK_LAUNCH_NONCE: spec.launchNonce };
  delete env.LILY_PROCESS_JOBS_SCOPE_SECRET;
  const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
    cwd: spec.cwd,
    env,
    shell: spec.shell,
    stdio: "inherit",
    windowsHide: true,
  });
  let settled = false;
  const finish = (exitCode, signal, error = null) => {
    if (settled) return;
    settled = true;
    clearInterval(heartbeatTimer);
    try {
      fs.mkdirSync(path.dirname(spec.markerPath), { recursive: true });
      atomicJson(spec.markerPath, {
        version: 1,
        launchNonce: spec.launchNonce,
        launcherPid: process.pid,
        workerPid: child.pid || null,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        error: error ? String(error.message || error).slice(0, 2000) : null,
        completedAt: Date.now(),
      });
    } catch { /* reconciliation will classify an absent marker conservatively */ }
    process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
  };
  child.once("error", (error) => finish(null, null, error));
  child.once("exit", (code, signal) => finish(code, signal));
}

main();
