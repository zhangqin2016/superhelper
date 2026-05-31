"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Directories never copied into shipped artifacts or user data merges. */
const SHIP_IGNORE_DIR_NAMES = new Set(["__MACOSX", "node_modules", ".git", ".github"]);

/** Files never copied into shipped artifacts. */
const SHIP_IGNORE_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Top-level dirs skipped when purging repo root (still purged if targeted directly). */
const SHIP_PURGE_WALK_SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  ".cache",
  ".idea",
]);

/** Relative paths purged before electron-builder (npm run purge:macos-junk). */
const SHIP_PURGE_DEFAULT_REL_PATHS = [
  "resources",
  "bundles",
  "src",
  "icon.icns",
  "icon.png",
];

/** electron-builder fileSet filter negations. */
const ELECTRON_BUILDER_JUNK_GLOBS = [
  "!**/__MACOSX/**",
  "!**/.DS_Store",
  "!**/._*",
  "!**/Thumbs.db",
  "!**/desktop.ini",
];

function isAppleDoubleFile(name) {
  return name.startsWith("._");
}

function isShipIgnoredEntry(name, isDirectory) {
  if (isDirectory && SHIP_IGNORE_DIR_NAMES.has(name)) return true;
  if (!isDirectory) {
    if (SHIP_IGNORE_FILE_NAMES.has(name)) return true;
    if (isAppleDoubleFile(name)) return true;
  }
  return false;
}

function shouldSkipPurgeWalkDir(name) {
  return SHIP_PURGE_WALK_SKIP.has(name);
}

/**
 * @param {string} source
 * @param {string} target
 * @param {{ chmodJs?: boolean }} [opts]
 */
function copyDirRecursiveShipSafe(source, target, opts = {}) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (isShipIgnoredEntry(entry.name, entry.isDirectory())) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveShipSafe(src, dst, opts);
    } else {
      fs.copyFileSync(src, dst);
      if (
        opts.chmodJs !== false &&
        process.platform !== "win32" &&
        (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
      ) {
        fs.chmodSync(dst, 0o755);
      }
    }
  }
}

/**
 * @param {string} rootDir
 * @param {{ skipWalkDirs?: Set<string> }} [opts]
 * @returns {{ dirs: string[], files: string[] }}
 */
function findJunkUnder(rootDir, opts = {}) {
  const skip = opts.skipWalkDirs || SHIP_PURGE_WALK_SKIP;
  const dirs = [];
  const files = [];
  if (!rootDir || !fs.existsSync(rootDir)) return { dirs, files };

  const rootStat = fs.statSync(rootDir);
  if (rootStat.isFile()) {
    const name = path.basename(rootDir);
    if (isShipIgnoredEntry(name, false)) files.push(rootDir);
    return { dirs, files };
  }

  function walk(dir, isTargetRoot) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isTargetRoot && entry.isDirectory() && skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (isShipIgnoredEntry(entry.name, entry.isDirectory())) {
        if (entry.isDirectory()) dirs.push(full);
        else files.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full, false);
    }
  }

  walk(rootDir, true);
  return { dirs, files };
}

/**
 * @param {string} rootDir
 * @param {{ skipWalkDirs?: Set<string> }} [opts]
 * @returns {{ dirs: number, files: number }}
 */
function purgeJunkUnder(rootDir, opts = {}) {
  const removed = { dirs: 0, files: 0 };
  if (!rootDir || !fs.existsSync(rootDir)) return removed;

  const rootStat = fs.statSync(rootDir);
  if (rootStat.isFile()) {
    const name = path.basename(rootDir);
    if (isShipIgnoredEntry(name, false)) {
      fs.rmSync(rootDir, { force: true });
      removed.files += 1;
    }
    return removed;
  }

  function walk(dir, isTargetRoot) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isTargetRoot && entry.isDirectory() && shouldSkipPurgeWalkDir(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (isShipIgnoredEntry(entry.name, entry.isDirectory())) {
        fs.rmSync(full, { recursive: true, force: true });
        if (entry.isDirectory()) removed.dirs += 1;
        else removed.files += 1;
        continue;
      }
      if (entry.isDirectory()) walk(full, false);
    }
  }

  walk(rootDir, true);
  return removed;
}

module.exports = {
  SHIP_IGNORE_DIR_NAMES,
  SHIP_IGNORE_FILE_NAMES,
  SHIP_PURGE_WALK_SKIP,
  SHIP_PURGE_DEFAULT_REL_PATHS,
  ELECTRON_BUILDER_JUNK_GLOBS,
  isShipIgnoredEntry,
  shouldSkipPurgeWalkDir,
  copyDirRecursiveShipSafe,
  findJunkUnder,
  purgeJunkUnder,
};
