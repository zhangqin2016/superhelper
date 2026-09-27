"use strict";

/**
 * Expose Electron's bundled Node (v24 in Electron 41) as `node` for engine/bash skills.
 * Uses ELECTRON_RUN_AS_NODE — the same pattern VS Code uses for its desktop shells.
 *
 * Electron running as Node still reports `process.versions.electron`, and the
 * common CLI parsers read that as "a packaged Electron app, whose argv has no
 * script entry": yargs' hideBin and commander both drop one argument less, so
 * the script's own path arrives as a stray argument. Every yargs/commander CLI
 * run from Lily's shell broke that way — electron-builder refused its own path
 * ("Unknown argument: …/.bin/electron-builder") and stopped a release
 * (2026-09-27). `process.defaultApp` is Electron's own flag for "argv[1] is a
 * script", which is exactly Node's layout, so the shim preloads a one-line
 * module that sets it. The shim runs without it if the file is missing.
 */

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const SHIM_MARKER = ".runtime-node-exec";
const ARGV_COMPAT_NAME = "node-argv-compat.cjs";
const ARGV_COMPAT_CONTENT = "// Lily: Electron running as Node uses Node's argv layout (see runtime-node.js).\n"
  + "if (process.versions.electron && !process.defaultApp) process.defaultApp = true;\n";

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

function argvCompatPath() {
  return path.join(runtimeBinDir(), ARGV_COMPAT_NAME);
}

function buildShimContent(execPath, compatPath = argvCompatPath(), platform = process.platform) {
  if (platform === "win32") {
    const quoted = `"${String(execPath).replace(/"/g, '""')}"`;
    const compat = `"${String(compatPath).replace(/"/g, '""')}"`;
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nif exist ${compat} (\r\n  ${quoted} --require ${compat} %*\r\n) else (\r\n  ${quoted} %*\r\n)\r\nexit /b %ERRORLEVEL%\r\n`;
  }
  const exec = shellQuoteSingle(execPath);
  const compat = shellQuoteSingle(compatPath);
  return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nif [ -f ${compat} ]; then exec ${exec} --require ${compat} "$@"; fi\nexec ${exec} "$@"\n`;
}

/** Write or refresh the node shim when the app binary path changes. */
function ensureRuntimeNodeShim() {
  const execPath = process.execPath;
  const binDir = runtimeBinDir();
  const shimPath = resolveRuntimeNodePath();
  const markerPath = execPathMarkerFile();

  fs.mkdirSync(binDir, { recursive: true });

  const compatPath = argvCompatPath();
  try {
    if (!fs.existsSync(compatPath) || fs.readFileSync(compatPath, "utf8") !== ARGV_COMPAT_CONTENT) {
      fs.writeFileSync(compatPath, ARGV_COMPAT_CONTENT, "utf8");
    }
  } catch (err) {
    // The shim falls back to plain Electron-as-Node when the file is absent.
    console.warn(`[runtime-node] argv compat preload not written (yargs/commander CLIs may misread their arguments): ${err?.message || err}`);
  }

  // The marker is the shim's whole content, not only the binary path: a shim
  // written by an older Lily for the same binary is stale too.
  const content = buildShimContent(execPath, compatPath);
  let stale = true;
  if (fs.existsSync(shimPath) && fs.existsSync(markerPath)) {
    try {
      stale = fs.readFileSync(markerPath, "utf8") !== content;
    } catch {
      stale = true;
    }
  }

  if (stale) {
    fs.writeFileSync(shimPath, content, "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(shimPath, 0o755);
    }
    fs.writeFileSync(markerPath, content, "utf8");
  }

  return shimPath;
}

module.exports = {
  ARGV_COMPAT_CONTENT,
  argvCompatPath,
  runtimeBinDir,
  resolveRuntimeNodePath,
  ensureRuntimeNodeShim,
  buildShimContent,
};
