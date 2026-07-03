"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE_APP_MANIFEST = "lily-app.json";
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_FILES = 20000;
const SKIPPED_SAMPLE_LIMIT = 50;

const DEFAULT_EXCLUDED_DIR_REASONS = new Map([
  [".lilyspace", "metadata-dir"],
  [".git", "vcs-dir"],
  ["node_modules", "dependency-dir"],
  ["__pycache__", "cache-dir"],
  [".venv", "dependency-dir"],
  ["venv", "dependency-dir"],
]);

const SCRATCH_DIRS = new Set([".lily-work"]);
const CACHE_DIRS = new Set(["cache", ".cache", "tmp", "temp"]);
const BENIGN_FILE_NAMES = new Set([".ds_store"]);
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/i;
const SECRET_FILE_RE =
  /(^\.env|\.(key|pem|p12|pfx|crt|cer|keystore|jks)$|^\.npmrc$|^\.netrc$|^id_rsa|^\.git-credentials$)/i;

function normalizeRelPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || path.isAbsolute(raw)) return "";
  const normalized = path.posix.normalize(raw.replace(/^\.\/+/, "").replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized.replace(/\/+$/g, "");
}

function isUnderRelPath(relPath, parentPath) {
  const rel = normalizeRelPath(relPath);
  const parent = normalizeRelPath(parentPath);
  return Boolean(parent && (rel === parent || rel.startsWith(`${parent}/`)));
}

function normalizePathList(paths) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(paths) ? paths : []) {
    const rel = normalizeRelPath(value);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function hasDescendantPath(relPath, paths) {
  const rel = normalizeRelPath(relPath);
  return Boolean(rel && paths.some((item) => item.startsWith(`${rel}/`)));
}

function isUnderAny(relPath, paths) {
  return paths.some((item) => isUnderRelPath(relPath, item));
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readWorkspaceAppManifest(rootPath) {
  const manifest = safeReadJson(path.join(rootPath, WORKSPACE_APP_MANIFEST));
  if (manifest?.type !== "workspace_app") return null;
  return manifest;
}

function extractDataLocationPaths(value) {
  const text = String(value || "");
  const paths = [];
  for (const match of text.matchAll(/\(([^)]+)\)/g)) {
    for (const part of String(match[1] || "").split(/[,，;；\s]+/)) {
      const rel = normalizeRelPath(part);
      if (rel) paths.push(rel);
    }
  }
  return paths;
}

function workspaceAppExportConfig(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return { dataPaths: [], excludePaths: [], confirmPaths: [] };
  }
  return {
    dataPaths: normalizePathList([
      ...(Array.isArray(manifest.export?.dataPaths) ? manifest.export.dataPaths : []),
      ...(Array.isArray(manifest.export?.includeDataPaths) ? manifest.export.includeDataPaths : []),
      ...(Array.isArray(manifest.dataPolicy?.dataPaths) ? manifest.dataPolicy.dataPaths : []),
      ...extractDataLocationPaths(manifest.dataPolicy?.dataLocation),
    ]),
    excludePaths: normalizePathList([
      ...(Array.isArray(manifest.export?.exclude) ? manifest.export.exclude : []),
      ...(Array.isArray(manifest.export?.excludePaths) ? manifest.export.excludePaths : []),
    ]),
    confirmPaths: normalizePathList([
      ...(Array.isArray(manifest.export?.confirm) ? manifest.export.confirm : []),
      ...(Array.isArray(manifest.export?.confirmPaths) ? manifest.export.confirmPaths : []),
    ]),
  };
}

function workspaceAppExportInfo(rootPath) {
  const manifest = readWorkspaceAppManifest(rootPath);
  if (!manifest) return null;
  const exportConfig = workspaceAppExportConfig(manifest);
  return {
    appId: String(manifest.appId || "").trim(),
    name: String(manifest.name || "").trim(),
    version: String(manifest.version || "").trim(),
    dataPaths: exportConfig.dataPaths,
    excludePaths: exportConfig.excludePaths,
    confirmPaths: exportConfig.confirmPaths,
  };
}

function formatDirRel(relPath) {
  const rel = normalizeRelPath(relPath);
  return rel ? `${rel}/` : "";
}

function classifyIncludedFile(relPath, explicitDataPaths = []) {
  const rel = normalizeRelPath(relPath);
  const top = rel.split("/")[0] || rel;
  if (isUnderAny(rel, explicitDataPaths)) return "app-data";
  if (top === "output") return "user-output";
  if (["cases", "data", "knowledge", "templates", "assets", "fixtures"].includes(top)) return "user-data";
  if (["source", "src", "scripts", "bin", "dist", "build"].includes(top)) return "app-core";
  if (["README.md", "AGENTS.md", "lily-app.json", "package.json", "package-lock.json"].includes(rel)) return "app-core";
  if (rel.startsWith(".")) return "workspace-config";
  return "workspace-file";
}

function exclusionForDir(relPath, includePaths = [], excludePaths = []) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return null;
  if (isUnderAny(rel, includePaths) || hasDescendantPath(rel, includePaths)) return null;
  if (isUnderAny(rel, excludePaths)) return { reason: "app-exclude" };

  const segments = rel.split("/");
  if (segments.some((segment) => CACHE_DIRS.has(segment))) {
    return { reason: "cache-dir" };
  }
  for (const segment of segments) {
    if (DEFAULT_EXCLUDED_DIR_REASONS.has(segment)) {
      return { reason: DEFAULT_EXCLUDED_DIR_REASONS.get(segment) };
    }
    if (SCRATCH_DIRS.has(segment)) return { reason: "scratch-dir" };
  }
  return null;
}

function exclusionForFile(relPath, includePaths = [], excludePaths = []) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return { reason: "invalid-path", warn: true };
  if (isUnderAny(rel, excludePaths)) return { reason: "app-exclude", warn: true };

  const base = path.basename(rel).toLowerCase();
  if (BENIGN_FILE_NAMES.has(base)) return { reason: "system-file", warn: false };
  if (ENV_TEMPLATE_RE.test(path.basename(rel))) return null;
  if (SECRET_FILE_RE.test(path.basename(rel))) return { reason: "secret-file", warn: true };
  if (!isUnderAny(rel, includePaths) && rel.split("/").some((segment) => SCRATCH_DIRS.has(segment))) {
    return { reason: "scratch-file", warn: true };
  }

  const dirRel = path.posix.dirname(rel);
  if (dirRel && dirRel !== ".") {
    const dirExclusion = exclusionForDir(dirRel, includePaths, excludePaths);
    if (dirExclusion) return { ...dirExclusion, warn: true };
  }
  return null;
}

function isExcluded(relPath, options = {}) {
  const includePaths = normalizePathList(options.includePaths);
  const excludePaths = normalizePathList(options.excludePaths);
  return options.isDirectory === true
    ? Boolean(exclusionForDir(relPath, includePaths, excludePaths))
    : Boolean(exclusionForFile(relPath, includePaths, excludePaths));
}

function addSample(list, item) {
  if (list.length < SKIPPED_SAMPLE_LIMIT) list.push(item);
}

function summarizeCategories(files) {
  const byCategory = new Map();
  for (const file of files) {
    const current = byCategory.get(file.category) || { category: file.category, fileCount: 0, totalBytes: 0 };
    current.fileCount += 1;
    current.totalBytes += file.size;
    byCategory.set(file.category, current);
  }
  return [...byCategory.values()].sort((a, b) => b.fileCount - a.fileCount || a.category.localeCompare(b.category));
}

function summarizeDataPaths(files, dataPaths) {
  return normalizePathList(dataPaths).map((dataPath) => {
    const matched = files.filter((file) => isUnderRelPath(file.relPath, dataPath));
    return {
      path: `${dataPath}/`,
      fileCount: matched.length,
      totalBytes: matched.reduce((sum, file) => sum + file.size, 0),
    };
  });
}

function planWorkspaceExport(rootPath, options = {}) {
  const workspaceApp = workspaceAppExportInfo(rootPath);
  const includePaths = normalizePathList([
    ...(workspaceApp?.dataPaths || []),
    ...(Array.isArray(options.includePaths) ? options.includePaths : []),
  ]);
  const excludePaths = normalizePathList([
    ...(workspaceApp?.excludePaths || []),
    ...(Array.isArray(options.excludePaths) ? options.excludePaths : []),
  ]);

  const files = [];
  const skippedFiles = [];
  const skippedDirs = [];
  let skippedFileCount = 0;
  let skippedDirCount = 0;
  let truncated = false;

  const noteSkippedFile = (item) => {
    if (item.warn !== false) {
      skippedFileCount += 1;
      addSample(skippedFiles, item);
    }
  };
  const noteSkippedDir = (item) => {
    skippedDirCount += 1;
    addSample(skippedDirs, item);
  };

  const walk = (dir, rel) => {
    if (files.length >= MAX_TOTAL_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_TOTAL_FILES) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const exclusion = exclusionForDir(childRel, includePaths, excludePaths);
        if (exclusion) {
          noteSkippedDir({ relPath: formatDirRel(childRel), reason: exclusion.reason });
          continue;
        }
        walk(fullPath, childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      const exclusion = exclusionForFile(childRel, includePaths, excludePaths);
      if (exclusion) {
        noteSkippedFile({ relPath: normalizeRelPath(childRel), reason: exclusion.reason, size: 0, warn: exclusion.warn });
        continue;
      }

      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        noteSkippedFile({ relPath: normalizeRelPath(childRel), reason: "unreadable", size: 0 });
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        noteSkippedFile({ relPath: normalizeRelPath(childRel), reason: "too-large", size });
        continue;
      }
      const relPath = normalizeRelPath(childRel);
      files.push({
        relPath,
        fullPath,
        size,
        category: classifyIncludedFile(relPath, includePaths),
      });
    }
  };

  walk(rootPath, "");
  const groups = new Map();
  for (const file of files) {
    const top = file.relPath.split("/")[0];
    const key = file.relPath.includes("/") ? `${top}/` : top;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return {
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    groups: [...groups.entries()].map(([name, count]) => ({ name, count })),
    categorySummary: summarizeCategories(files),
    skippedFiles: skippedFiles.map(({ warn, ...item }) => item),
    skippedDirs,
    skippedFileCount,
    skippedDirCount,
    truncated,
    workspaceApp,
    appDataPaths: summarizeDataPaths(files, includePaths),
    includePaths,
    excludePaths,
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalFiles: MAX_TOTAL_FILES,
    },
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TOTAL_FILES,
  normalizeRelPath,
  isUnderRelPath,
  normalizePathList,
  readWorkspaceAppManifest,
  workspaceAppExportConfig,
  workspaceAppExportInfo,
  classifyIncludedFile,
  isExcluded,
  planWorkspaceExport,
};
