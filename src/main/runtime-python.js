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

/**
 * PATH segments to prepend when a bundled runtime exists (highest priority first).
 * @returns {string[]}
 */
function getRuntimePathEntries() {
  const root = resolveBundledRuntimeRoot();
  if (!root) return [];

  const entries = [];
  const bin = runtimeBinDir(root);
  const venvBin = venvBinDir(root);
  const sofficeDir = resolveSofficeDir(root);

  if (fs.existsSync(bin)) entries.push(bin);
  if (fs.existsSync(venvBin)) entries.push(venvBin);
  if (sofficeDir) entries.push(sofficeDir);

  return entries;
}

/**
 * Extra env vars for agent subprocesses (LibreOffice UNO paths, runtime root marker).
 * @returns {Record<string, string>}
 */
function getRuntimeEnvExtras() {
  const root = resolveBundledRuntimeRoot();
  if (!root) return {};

  const extras = { LILY_RUNTIME_ROOT: root };
  const sofficeDir = resolveSofficeDir(root);
  if (sofficeDir) {
    extras.LILY_LIBREOFFICE_PROGRAM = sofficeDir;
    if (process.platform === "darwin") {
      const resources = path.join(
        root,
        "libreoffice",
        "LibreOffice.app",
        "Contents",
        "Resources",
      );
      if (fs.existsSync(resources)) {
        extras.UNO_PATH = resources;
      }
    } else {
      extras.UNO_PATH = sofficeDir;
    }
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
  getRuntimePathEntries,
  getRuntimeEnvExtras,
  getRuntimeSummary,
};
