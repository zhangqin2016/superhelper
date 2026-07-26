"use strict";

/**
 * Resolve bundled Python / uv / venv / LibreOffice paths for agent subprocesses.
 * Runtime is built by scripts/build-runtime-bundle.mjs into bundles/<platform>/runtime/.
 */

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");
const { platformBundleKeys } = require("./bundle-locator");
const { resolveCjkFontPath } = require("./document-fonts");

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

const fixedVenvCfgRoots = new Set();

/**
 * Legacy fallback for older Windows bundles that execute the venv launcher.
 * Current bundles resolve the relocatable base interpreter instead, because an
 * installed app may not have permission to rewrite files under Program Files.
 */
function ensureVenvCfgFixed(runtimeRoot, { platform = process.platform } = {}) {
  if (platform !== "win32" || !runtimeRoot || fixedVenvCfgRoots.has(runtimeRoot)) return;
  fixedVenvCfgRoots.add(runtimeRoot);
  try {
    const cfgPath = path.join(runtimeRoot, "venv", "pyvenv.cfg");
    if (!fs.existsSync(cfgPath)) return;
    const raw = fs.readFileSync(cfgPath, "utf8");
    const readValue = (key) => (raw.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "mi")) || [])[1]?.trim() || "";
    const home = readValue("home");
    const exe = readValue("executable");
    // Dirty = home missing/placeholder/nonexistent, or an executable line that is
    // present but stale. A missing executable line alone is fine (informational).
    const dirty =
      !home || home.includes("__LILY_") || !fs.existsSync(home) ||
      (exe && (exe.includes("__LILY_") || !fs.existsSync(exe)));
    if (!dirty) return;
    const pythonRoot = path.join(runtimeRoot, "python");
    let cpythonDir = "";
    try {
      cpythonDir =
        fs
          .readdirSync(pythonRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^cpython-/i.test(entry.name))
          .map((entry) => path.join(pythonRoot, entry.name))[0] || "";
    } catch {
      cpythonDir = "";
    }
    if (!cpythonDir) return;
    const executable = path.join(runtimeRoot, "venv", platform === "win32" ? "Scripts" : "bin", "python.exe");
    const kept = raw.split(/\r?\n/).filter((line) => line.trim() && !/^(home|executable)\s*=/i.test(line));
    fs.writeFileSync(cfgPath, [`home = ${cpythonDir}`, ...kept, `executable = ${executable}`].join("\r\n") + "\r\n");
  } catch {
    // Read-only install dir or partial bundle: best effort — a failed probe
    // afterwards is exactly as diagnosable as before this fixup existed.
  }
}

function venvBinDir(runtimeRoot) {
  const sub = process.platform === "win32" ? "Scripts" : "bin";
  return path.join(runtimeRoot, "venv", sub);
}

function runtimeBinDir(runtimeRoot) {
  return path.join(runtimeRoot, "bin");
}

function findBundledBasePython(runtimeRoot) {
  const pythonRoot = path.join(runtimeRoot, "python");
  let installs = [];
  try {
    installs = fs
      .readdirSync(pythonRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^cpython-/i.test(entry.name))
      .map((entry) => path.join(pythonRoot, entry.name));
  } catch {
    return null;
  }
  for (const installDir of installs) {
    const direct = path.join(installDir, "python.exe");
    if (fs.existsSync(direct)) return direct;
    const nested = path.join(installDir, "python", "python.exe");
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

function resolveRuntimePythonAtRoot(runtimeRoot, { platform = process.platform } = {}) {
  if (!runtimeRoot) return null;
  if (platform === "win32") {
    const basePython = findBundledBasePython(runtimeRoot);
    if (basePython) return basePython;
  }
  const exe = platform === "win32" ? "python.exe" : "python3";
  const sub = platform === "win32" ? "Scripts" : "bin";
  const candidate = path.join(runtimeRoot, "venv", sub, exe);
  return fs.existsSync(candidate) ? candidate : null;
}

function getBundledPythonPathsAtRoot(runtimeRoot, { platform = process.platform } = {}) {
  if (!runtimeRoot || platform !== "win32" || !findBundledBasePython(runtimeRoot)) return [];
  const sitePackages = path.join(runtimeRoot, "venv", "Lib", "site-packages");
  return fs.existsSync(sitePackages) ? [sitePackages] : [];
}

function getBundledPythonEnv(baseEnv = process.env) {
  const root = resolveBundledRuntimeRoot();
  const pythonPaths = [
    ...getBundledPythonPathsAtRoot(root),
    baseEnv.PYTHONPATH,
  ].filter(Boolean);
  return {
    ...baseEnv,
    ...(pythonPaths.length ? { PYTHONPATH: pythonPaths.join(path.delimiter) } : {}),
  };
}

/**
 * Absolute path to the bundled Python interpreter, or null if no runtime is
 * present. Windows prefers the relocatable base interpreter and receives the
 * venv libraries through PYTHONPATH; other platforms use the venv interpreter.
 * @returns {string|null}
 */
function resolveVenvPython() {
  const root = resolveBundledRuntimeRoot();
  return resolveRuntimePythonAtRoot(root);
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
    const python = resolveRuntimePythonAtRoot(root);
    const sofficeDir = resolveSofficeDir(root);
    const nodeDir = resolveBundledNodeDir(root);

    if (fs.existsSync(bin)) entries.push(bin);
    if (process.platform === "win32" && python) entries.push(path.dirname(python));
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
  const runtimePacks = require("./runtime-packs");
  const packPythonPaths = runtimePacks.getRuntimePackPythonPaths();
  const pythonPaths = [...packPythonPaths, ...getBundledPythonPathsAtRoot(root)];
  if (pythonPaths.length) extras.PYTHONPATH = pythonPaths.join(path.delimiter);
  Object.assign(extras, runtimePacks.getRuntimePackEnvExtras());
  const packLibreOfficeDir = runtimePacks.getRuntimePackLibreOfficeDirs()[0];
  const sofficeDir = (root && resolveSofficeDir(root)) || packLibreOfficeDir || null;
  if (sofficeDir) {
    extras.LILY_LIBREOFFICE_PROGRAM = sofficeDir;
    extras.UNO_PATH = resolveUnoPath(sofficeDir);
  }
  const cjkFontPath = resolveCjkFontPath();
  if (cjkFontPath) extras.LILY_CJK_FONT_PATH = cjkFontPath;
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
  resolveRuntimePythonAtRoot,
  getBundledPythonPathsAtRoot,
  getBundledPythonEnv,
  resolveBundledUv,
  resolveBundledNodeDir,
  ensureVenvCfgFixed,
  getRuntimePathEntries,
  getRuntimeEnvExtras,
  getRuntimeSummary,
};
