"use strict";

/**
 * Runtime packs — main-process reader utilities.
 *
 * Optional heavy engines and toolchains can come from two sources:
 *
 * 1. Bundled read-only packs shipped in resources/bundles/<platform>/runtime-packs/<id>/.
 * 2. User-installed override packs in the selected runtime-pack root, recorded
 *    next to that root's runtime-packs/ directory.
 * 3. Legacy userData/runtime-packs/<id>/ installs, kept as a fallback so users
 *    who choose a new dependency location do not lose older capabilities.
 *
 * User-installed packs intentionally win over bundled packs so the app can ship
 * a direct-use baseline while still allowing later pack updates without copying
 * gigabytes into userData on first launch.
 */

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");
const { platformBundleKeys } = require("./bundle-locator");
const { PACK_SPECS } = require("./runtime-pack-specs");

const STATE_SCHEMA_VERSION = 1;

function config() {
  return require("./config");
}

function packsRoot() {
  return config().runtimePackPacksRoot();
}

function packDir(id, root = packsRoot()) {
  return path.join(root, id);
}

function bundledPacksRootCandidates() {
  const roots = [];
  const envRoots = String(process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  roots.push(...envRoots);

  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  for (const key of platformBundleKeys()) {
    if (resourcesPath) {
      roots.push(path.join(resourcesPath, "bundles", key, "runtime-packs"));
    }
    roots.push(path.join(PROJECT_ROOT, "bundles", key, "runtime-packs"));
  }
  return roots;
}

function bundledPackDir(id) {
  if (!id) return "";
  for (const root of bundledPacksRootCandidates()) {
    const dir = path.join(root, id);
    if (fs.existsSync(dir)) return dir;
  }
  return "";
}

function listBundledRuntimePackDirs() {
  const found = new Map();
  for (const root of bundledPacksRootCandidates()) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!found.has(entry.name)) found.set(entry.name, path.join(root, entry.name));
    }
  }
  return found;
}

function statePath() {
  return config().runtimePackStatePath();
}

function legacyPacksRoot() {
  return config().legacyRuntimePackPacksRoot();
}

function legacyStatePath() {
  return config().legacyRuntimePackStatePath();
}

function packBaseStatePath(baseDir) {
  return path.join(baseDir, "runtime-packs.json");
}

function packBasePacksRoot(baseDir) {
  return path.join(baseDir, "runtime-packs");
}

function readStateFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.installed) {
      return { schemaVersion: STATE_SCHEMA_VERSION, installed: raw.installed };
    }
  } catch {
    /* no state file yet → nothing installed */
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, installed: {} };
}

function readState() {
  return readStateFile(statePath());
}

function installState(kind, statePathFn, packsRootFn) {
  try {
    const file = statePathFn();
    return {
      kind,
      statePath: file,
      packsRoot: packsRootFn(),
      state: readStateFile(file),
    };
  } catch {
    return null;
  }
}

function readInstallStates() {
  const primary = installState("selected", statePath, packsRoot);
  const fallbackStates = config().runtimePackFallbackBaseDirs()
    .map((baseDir, index) => installState(
      `fallback-${index}`,
      () => packBaseStatePath(baseDir),
      () => packBasePacksRoot(baseDir),
    ))
    .filter(Boolean);
  const legacy = installState("legacy", legacyStatePath, legacyPacksRoot);
  const states = [primary, ...fallbackStates, legacy].filter(Boolean);
  const seen = new Set();
  return states.filter((item) => {
    const key = path.resolve(item.statePath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function installedRecordExists(id, rec, root = packsRoot()) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.source === "pip") return true;
  return fs.existsSync(packDir(id, root));
}

function userPackDirIfInstalled(id, rec, root = packsRoot()) {
  if (!installedRecordExists(id, rec, root)) return "";
  if (rec?.source === "pip") return "";
  const dir = packDir(id, root);
  return fs.existsSync(dir) ? dir : "";
}

function effectivePackEntries() {
  const entries = [];
  const seen = new Set();

  for (const installState of readInstallStates()) {
    for (const [id, rec] of Object.entries(installState.state.installed || {})) {
      if (seen.has(id)) continue;
      const dir = userPackDirIfInstalled(id, rec, installState.packsRoot);
      if (!dir && rec?.source !== "pip") continue;
      entries.push({ id, dir, source: rec?.source || "artifact", record: rec, stateKind: installState.kind });
      seen.add(id);
    }
  }

  for (const [id, dir] of listBundledRuntimePackDirs()) {
    if (seen.has(id)) continue;
    entries.push({ id, dir, source: "bundled", record: null });
    seen.add(id);
  }

  return entries;
}

function isPythonPathPack(id) {
  const spec = PACK_SPECS[id];
  if (spec) return spec.pythonPath === true;
  // Backward compatibility for old userData state: before specs gained
  // pack-kind metadata, every non-LibreOffice artifact was treated as a
  // PYTHONPATH add-on.
  return id !== "libreoffice";
}

function pythonPathPriority(id) {
  const priority = Number(PACK_SPECS[id]?.pythonPathPriority || 0);
  return Number.isFinite(priority) ? priority : 0;
}

/**
 * PYTHONPATH entries for installed packs, so the document extractor can import
 * Python add-on engines. Only dirs that actually exist on disk are returned.
 * Native tool packs (ffmpeg/pandoc/browser runtimes) are intentionally excluded.
 * @returns {string[]}
 */
function getRuntimePackPythonPaths() {
  return effectivePackEntries()
    .filter((entry) => isPythonPathPack(entry.id))
    .filter((entry) => entry.source !== "pip")
    .sort((a, b) => pythonPathPriority(b.id) - pythonPathPriority(a.id))
    .map((entry) => entry.dir)
    .filter((dir) => fs.existsSync(dir));
}

function executableExists(dir) {
  const exe = process.platform === "win32" ? "soffice.exe" : "soffice";
  return fs.existsSync(path.join(dir, exe));
}

function getRuntimePackLibreOfficeDirs() {
  const seen = new Set();
  const dirs = [];
  for (const entry of effectivePackEntries().filter((item) => item.id === "libreoffice")) {
    if (entry.source === "pip" || !entry.dir) continue;
    const root = entry.dir;
    const candidates = [
      path.join(root, "LibreOffice.app", "Contents", "MacOS"),
      path.join(root, "program"),
      path.join(root, "Program"),
      path.join(root, "libreoffice", "LibreOffice.app", "Contents", "MacOS"),
      path.join(root, "libreoffice", "program"),
      path.join(root, "libreoffice", "Program"),
      path.join(root, "opt", "libreoffice", "program"),
    ];
    for (const dir of candidates) {
      if (!executableExists(dir)) continue;
      const key = fs.realpathSync.native?.(dir) || fs.realpathSync(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(dir);
    }
  }
  return dirs;
}

function resolveRelativePackPath(dir, relPath) {
  if (!relPath || path.isAbsolute(relPath)) return "";
  const candidate = path.join(dir, relPath);
  return fs.existsSync(candidate) ? candidate : "";
}

function pythonPackPathEntries(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = [path.join(dir, "bin"), path.join(dir, "Scripts")];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && /\.libs$/i.test(entry.name)) entries.push(path.join(dir, entry.name));
    }
  } catch {
    // Pack dirs can be removed while the settings page refreshes; ignore races.
  }
  return entries.filter((entry) => fs.existsSync(entry));
}

function getRuntimePackPathEntries() {
  const entries = [];
  const seen = new Set();
  for (const { id, dir } of effectivePackEntries()) {
    if (!dir) continue;
    const spec = PACK_SPECS[id];
    const candidates = [
      ...(Array.isArray(spec?.pathEntries) ? spec.pathEntries.map((rel) => resolveRelativePackPath(dir, rel)) : []),
      ...(isPythonPathPack(id) ? pythonPackPathEntries(dir) : []),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const key = fs.realpathSync.native?.(candidate) || fs.realpathSync(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(candidate);
    }
  }
  return entries;
}

function getRuntimePackEnvExtras() {
  const extras = {};
  for (const { id, dir } of effectivePackEntries()) {
    if (!dir) continue;
    const entries = PACK_SPECS[id]?.envEntries;
    if (!entries || typeof entries !== "object") continue;
    for (const [name, rel] of Object.entries(entries)) {
      const candidate = resolveRelativePackPath(dir, rel);
      if (candidate) extras[name] = candidate;
    }
  }
  return extras;
}

module.exports = {
  getRuntimePackPythonPaths,
  getRuntimePackLibreOfficeDirs,
  getRuntimePackPathEntries,
  getRuntimePackEnvExtras,
  bundledPackDir,
  bundledPacksRootCandidates,
  effectivePackEntries,
  listBundledRuntimePackDirs,
  packDir,
  packsRoot,
  readInstallStates,
  readState,
  legacyPacksRoot,
  legacyStatePath,
  statePath,
};
