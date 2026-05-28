"use strict";

/**
 * Expose Electron's bundled Node (v24 in Electron 41) as `node` for Claude/bash skills.
 * Uses ELECTRON_RUN_AS_NODE — same pattern as VS Code / Claude Code desktop shells.
 */

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const SHIM_MARKER = ".runtime-node-exec";

function runtimeBinDir() {
  return userDataPath("runtime-bin");
}

function nodeShimName() {
  return process.platform === "win32" ? "node.cmd" : "node";
}

function resolveRuntimeNodePath() {
  return path.join(runtimeBinDir(), nodeShimName());
}

function execPathMarkerFile() {
  return path.join(runtimeBinDir(), SHIM_MARKER);
}

function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildShimContent(execPath) {
  if (process.platform === "win32") {
    const quoted = `"${String(execPath).replace(/"/g, '""')}"`;
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quoted} %*\r\n`;
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuoteSingle(execPath)} "$@"\n`;
}

/** Write or refresh the node shim when the app binary path changes. */
function ensureRuntimeNodeShim() {
  const execPath = process.execPath;
  const binDir = runtimeBinDir();
  const shimPath = resolveRuntimeNodePath();
  const markerPath = execPathMarkerFile();

  fs.mkdirSync(binDir, { recursive: true });

  let stale = true;
  if (fs.existsSync(shimPath) && fs.existsSync(markerPath)) {
    try {
      stale = fs.readFileSync(markerPath, "utf8") !== execPath;
    } catch {
      stale = true;
    }
  }

  if (stale) {
    fs.writeFileSync(shimPath, buildShimContent(execPath), "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(shimPath, 0o755);
    }
    fs.writeFileSync(markerPath, execPath, "utf8");
  }

  return shimPath;
}

module.exports = {
  runtimeBinDir,
  resolveRuntimeNodePath,
  ensureRuntimeNodeShim,
  buildShimContent,
};
