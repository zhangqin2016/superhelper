"use strict";

/**
 * Resolve bundled Python / uv / venv / LibreOffice paths for agent subprocesses.
 * Runtime is built by scripts/build-runtime-bundle.mjs into bundles/<platform>/runtime/.
 */

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");
const { platformBundleKeys } = require("./bundle-locator");

function bundledRuntimeCandidates() {
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  const paths = [];
  // Agent subprocesses (plain node, no process.resourcesPath) get the runtime
  // root via this env var, injected by spawn-env's getRuntimeEnvExtras(). Lets
  // a standalone CLI find the bundled venv/uv in packaged builds too.
  if (process.env.LILY_RUNTIME_ROOT) {
    paths.push(process.env.LILY_RUNTIME_ROOT);
  }
  for (const key of platformBundleKeys()) {
    if (resourcesPath) {
      paths.push(path.join(resourcesPath, "bundles", key, "runtime"));
    }
    paths.push(path.join(PROJECT_ROOT, "bundles", key, "runtime"));
  }
  return paths;
}

function readManifest(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveBundledRuntimeRoot() {
  for (const candidate of bundledRuntimeCandidates()) {
    const manifest = readManifest(candidate);
    if (manifest?.platform) return candidate;
  }
  return null;
}

function venvBinDir(runtimeRoot) {
  const sub = process.platform === "win32" ? "Scripts" : "bin";
  return path.join(runtimeRoot, "venv", sub);
}

function runtimeBinDir(runtimeRoot) {
  return path.join(runtimeRoot, "bin");
}

/**
 * Absolute path to the bundled venv Python interpreter, or null if no runtime
 * is present. Lets the main process delegate document parsing to the
 * best-in-class Python libraries that ship in the venv.
 * @returns {string|null}
 */
function resolveVenvPython() {
  const root = resolveBundledRuntimeRoot();
  if (!root) return null;
  const exe = process.platform === "win32" ? "python.exe" : "python3";
  const candidate = path.join(venvBinDir(root), exe);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Absolute path to the bundled `uv` binary, or null if no runtime is present.
 * Lets on-demand capability packs install extra Python deps into the venv with
 * the same tool the build uses (`uv pip install --python <venv>`).
 * @returns {string|null}
 */
function resolveBundledUv() {
  const root = resolveBundledRuntimeRoot();
  if (!root) return null;
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  const candidate = path.join(runtimeBinDir(root), exe);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Directory holding a usable `node` binary inside the bundle, or null.
 *
 * The runtime bundle does not ship a standalone node, but Playwright vendors a
 * full Node runtime under its driver dir (every platform). The OpenCode engine
 * spawns node-based language servers (pyright, typescript-language-server) whose
 * bins are `#!/usr/bin/env node` scripts — without `node` on PATH they fail to
 * start, so the code-intelligence loop silently no-ops. Surfacing this node dir
 * on the agent PATH is what makes that loop actually run on packaged builds.
 * @returns {string|null}
 */
function resolveBundledNodeDir(runtimeRoot) {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const driverDirs = [];
  // Windows venv: venv/Lib/site-packages/...; POSIX: venv/lib/python3.X/site-packages/...
  if (process.platform === "win32") {
    driverDirs.push(
      path.join(runtimeRoot, "venv", "Lib", "site-packages", "playwright", "driver"),
    );
  } else {
    const libDir = path.join(runtimeRoot, "venv", "lib");
    let pythonDirs = [];
    try {
      pythonDirs = fs
        .readdirSync(libDir)
        .filter((name) => name.startsWith("python3."))
        .map((name) => path.join(libDir, name));
    } catch {
      pythonDirs = [];
    }
    for (const dir of pythonDirs) {
      driverDirs.push(path.join(dir, "site-packages", "playwright", "driver"));
    }
  }
  for (const dir of driverDirs) {
    if (fs.existsSync(path.join(dir, exe))) return dir;
  }
  return null;
}

function resolveSofficeDir(runtimeRoot) {
  const candidates = [
    path.join(runtimeRoot, "libreoffice", "LibreOffice.app", "Contents", "MacOS"),
    path.join(runtimeRoot, "libreoffice", "usr-lib", "program"),
    path.join(runtimeRoot, "libreoffice", "program"),
    path.join(runtimeRoot, "libreoffice", "Program"),
    path.join(runtimeRoot, "libreoffice", "opt", "libreoffice", "program"),
  ];
  for (const dir of candidates) {
    const exe =
      process.platform === "win32"
        ? path.join(dir, "soffice.exe")
        : path.join(dir, "soffice");
    if (fs.existsSync(exe)) return dir;
  }
  return null;
}

function resolveUnoPath(sofficeDir) {
  if (!sofficeDir) return null;
  if (process.platform === "darwin" && path.basename(sofficeDir) === "MacOS") {
    const resources = path.join(path.dirname(sofficeDir), "Resources");
    if (fs.existsSync(resources)) return resources;
  }
  return sofficeDir;
}

/**
 * PATH segments to prepend when a bundled runtime exists (highest priority first).
 * @returns {string[]}
 */
function getRuntimePathEntries() {
  const root = resolveBundledRuntimeRoot();
  const entries = [];
  if (root) {
    const bin = runtimeBinDir(root);
    const venvBin = venvBinDir(root);
    const sofficeDir = resolveSofficeDir(root);
    const nodeDir = resolveBundledNodeDir(root);

    if (fs.existsSync(bin)) entries.push(bin);
    if (fs.existsSync(venvBin)) entries.push(venvBin);
    if (sofficeDir) entries.push(sofficeDir);
    // node for the engine's node-based language servers (pyright/tsserver).
    if (nodeDir) entries.push(nodeDir);
  }
  const packLibreOfficeDirs = require("./runtime-packs").getRuntimePackLibreOfficeDirs();
  for (const dir of packLibreOfficeDirs) {
    if (!entries.includes(dir)) entries.push(dir);
  }
  const packPathEntries = require("./runtime-packs").getRuntimePackPathEntries();
  for (const dir of packPathEntries) {
    if (!entries.includes(dir)) entries.push(dir);
  }

  return entries;
}

/**
 * Extra env vars for agent subprocesses (LibreOffice UNO paths, runtime root marker).
 * @returns {Record<string, string>}
 */
function getRuntimeEnvExtras() {
  const root = resolveBundledRuntimeRoot();
  const extras = {};
  if (root) extras.LILY_RUNTIME_ROOT = root;
  Object.assign(extras, require("./runtime-packs").getRuntimePackEnvExtras());
  const packLibreOfficeDir = require("./runtime-packs").getRuntimePackLibreOfficeDirs()[0];
  const sofficeDir = (root && resolveSofficeDir(root)) || packLibreOfficeDir || null;
  if (sofficeDir) {
    extras.LILY_LIBREOFFICE_PROGRAM = sofficeDir;
    extras.UNO_PATH = resolveUnoPath(sofficeDir);
  }
  return extras;
}

function getRuntimeSummary() {
  const root = resolveBundledRuntimeRoot();
  if (!root) return { available: false };
  return {
    available: true,
    root,
    manifest: readManifest(root),
    pathEntries: getRuntimePathEntries(),
  };
}

module.exports = {
  platformBundleKeys,
  resolveBundledRuntimeRoot,
  resolveVenvPython,
  resolveBundledUv,
  resolveBundledNodeDir,
  getRuntimePathEntries,
  getRuntimeEnvExtras,
  getRuntimeSummary,
};
