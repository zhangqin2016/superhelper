"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INTERNAL_DIR = ".lily-work";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_GIT_FILES = 100_000;
const MAX_GIT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const HISTORY_LIMIT = 50;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".lily-work",
  ".cache",
  ".next",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
  "target",
]);

function normalizeRelative(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isWithinWorkspace(workspacePath, filePath) {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(filePath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function relativePath(workspacePath, filePath) {
  if (!isWithinWorkspace(workspacePath, filePath)) return "";
  const relative = normalizeRelative(path.relative(workspacePath, filePath));
  return relative === "." ? "" : relative;
}

function isIgnoredRelativePath(relative) {
  const normalized = normalizeRelative(relative);
  if (!normalized || normalized === INTERNAL_DIR || normalized.startsWith(`${INTERNAL_DIR}/`)) return true;
  const segments = normalized.split("/");
  if (segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment))) return true;
  const basename = (segments[segments.length - 1] || "").toLowerCase();
  if (basename === ".ds_store" || basename === "thumbs.db") return true;
  if (/^\.env(?:\..+)?$/.test(basename)) return true;
  if ([".npmrc", ".pypirc", ".netrc", "config.json"].includes(basename)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/.test(basename)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|secret|secrets|token|tokens|credential|credentials)$/i.test(basename)) return true;
  if (/^(credentials|service-account)(\.|$)/.test(basename) && /\.json$/.test(basename)) return true;
  return false;
}

function isSafeRelativePath(relative) {
  const normalized = normalizeRelative(relative);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return false;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return false;
  return !isIgnoredRelativePath(normalized);
}

function safeAbsolutePath(workspacePath, relative) {
  if (!isSafeRelativePath(relative)) return "";
  const absolute = path.resolve(workspacePath, normalizeRelative(relative));
  return isWithinWorkspace(workspacePath, absolute) ? absolute : "";
}

function describeStatusCode(code) {
  const value = String(code || "");
  if (value.includes("?") || value === "??") return "untracked";
  if (value.includes("D")) return "deleted";
  if (value.includes("R")) return "renamed";
  return "modified";
}

function assertSafeExistingPath(workspacePath, relative) {
  const absolute = safeAbsolutePath(workspacePath, relative);
  if (!absolute) return null;
  let current = absolute;
  while (!isWithinWorkspace(workspacePath, current)) return null;
  while (current !== path.resolve(workspacePath)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return null;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      current = path.dirname(current);
    }
  }
  return absolute;
}

async function collectSafeFiles(workspacePath, options = {}) {
  const root = path.resolve(workspacePath);
  const maxFiles = Number.isSafeInteger(options.maxFiles) ? options.maxFiles : MAX_FILES;
  const maxTotalBytes = Number.isSafeInteger(options.maxTotalBytes) ? options.maxTotalBytes : MAX_TOTAL_BYTES;
  const files = [];
  let totalBytes = 0;
  let truncated = false;

  async function visit(directory, relativeDirectory = "") {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = normalizeRelative(path.join(relativeDirectory, entry.name));
      if (isIgnoredRelativePath(relative)) continue;
      const absolute = path.join(root, relative);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        if (truncated) return;
        continue;
      }
      // Symlinks and special files are deliberately outside the protection
      // boundary; following them could copy content outside the workspace.
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const stat = await fs.promises.lstat(absolute);
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > maxTotalBytes) {
        truncated = true;
        return;
      }
      files.push({ relative, absolute, size: stat.size });
      totalBytes += stat.size;
    }
  }

  await visit(root);
  return { files, totalBytes, truncated };
}

function createExcludeFile() {
  return [
    ".lily-work/",
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "release/",
    "coverage/",
    ".cache/",
    ".next/",
    "out/",
    "target/",
    "__pycache__/",
    ".DS_Store",
    "Thumbs.db",
    ".env",
    ".env.*",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "config.json",
    "*.local",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "*.secret",
    "*.secrets",
    "*.token",
    "*.tokens",
    "*.credential",
    "*.credentials",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    "credentials*.json",
    "service-account*.json",
    "",
  ].join("\n");
}

module.exports = {
  INTERNAL_DIR,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_FILES,
  MAX_GIT_FILES,
  MAX_GIT_TOTAL_BYTES,
  HISTORY_LIMIT,
  normalizeRelative,
  relativePath,
  isWithinWorkspace,
  isIgnoredRelativePath,
  isSafeRelativePath,
  safeAbsolutePath,
  assertSafeExistingPath,
  describeStatusCode,
  collectSafeFiles,
  createExcludeFile,
};
