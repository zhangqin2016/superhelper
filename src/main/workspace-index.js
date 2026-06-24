"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_IGNORES = new Set([
  ".cache",
  ".git",
  ".lily-work",
  "bundles",
  "dist",
  "generated-assets",
  "node_modules",
  "release",
  "release-keys",
]);

const DEFAULT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const CACHE = new Map();
const MAX_INDEXED_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_TEXT_BYTES = 2 * 1024 * 1024;

function normalizeRoot(root) {
  return root ? path.resolve(root) : "";
}

function shouldIgnoreDir(name, ignores = DEFAULT_IGNORES) {
  return ignores.has(name);
}

function walk(root, dir, out, opts) {
  if (out.length >= opts.maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= opts.maxFiles) return;
    if (entry.isDirectory()) {
      if (!shouldIgnoreDir(entry.name, opts.ignores)) {
        walk(root, path.join(dir, entry.name), out, opts);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (opts.extensions.size && !opts.extensions.has(ext)) continue;
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }
    out.push({
      path: absolutePath,
      relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      ext,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      searchText: readSearchText(absolutePath, stat.size, opts),
    });
  }
}

function readSearchText(filePath, size, opts) {
  if (size > MAX_INDEXED_TEXT_BYTES) return "";
  if (opts.indexedTextBytes + size > opts.maxTotalTextBytes) return "";
  try {
    const text = fs.readFileSync(filePath, "utf8").slice(0, MAX_INDEXED_TEXT_BYTES);
    opts.indexedTextBytes += Buffer.byteLength(text, "utf8");
    return text;
  } catch {
    return "";
  }
}

function getWorkspaceIndex(rootPath, options = {}) {
  const root = normalizeRoot(rootPath);
  if (!root) return { root: "", files: [], truncated: false };
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 5000;
  const maxTotalTextBytes = Number.isFinite(options.maxTotalTextBytes)
    ? options.maxTotalTextBytes
    : DEFAULT_MAX_TOTAL_TEXT_BYTES;
  const cacheKey = `${root}:${maxFiles}:${maxTotalTextBytes}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;
  const files = [];
  const opts = {
    maxFiles,
    ignores: options.ignores || DEFAULT_IGNORES,
    extensions: options.extensions || DEFAULT_EXTENSIONS,
    maxTotalTextBytes,
    indexedTextBytes: 0,
  };
  walk(root, root, files, opts);
  const index = { root, files, truncated: files.length >= maxFiles, createdAt: Date.now() };
  CACHE.set(cacheKey, index);
  return index;
}

function searchWorkspaceIndex(rootPath, terms = [], options = {}) {
  const index = getWorkspaceIndex(rootPath, options);
  const needles = (terms || []).map((term) => String(term || "").trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return [];
  const limit = Number.isFinite(options.limit) ? options.limit : 100;
  const hits = [];
  for (const file of index.files) {
    const haystack = `${file.relativePath}\n${path.basename(file.relativePath)}\n${file.searchText || ""}`.toLowerCase();
    if (!needles.some((needle) => haystack.includes(needle))) continue;
    hits.push(file);
    if (hits.length >= limit) break;
  }
  return hits;
}

module.exports = {
  getWorkspaceIndex,
  searchWorkspaceIndex,
};
