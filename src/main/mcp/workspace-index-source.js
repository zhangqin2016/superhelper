"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function readTextFile(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) return null;
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function contentHash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

function readDirectoryEntriesBounded(dirPath, maxEntries) {
  const limit = Math.max(1, Number(maxEntries || 1));
  const entries = [];
  let exhausted = false;
  let dir;
  try {
    dir = fs.opendirSync(dirPath);
    while (entries.length <= limit) {
      const entry = dir.readSync();
      if (!entry) {
        exhausted = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    return { entries: [], scannedCount: 0, truncated: false, readable: false };
  } finally {
    try { dir?.closeSync(); } catch { /* already closed */ }
  }
  return {
    entries: entries.slice(0, limit),
    scannedCount: entries.length,
    truncated: !exhausted || entries.length > limit,
    readable: true,
  };
}

function candidateFiles(rootPath, opts = {}) {
  const maxFiles = Math.max(1, Number(opts.maxFiles || 200));
  const maxEntries = Math.max(1, Number(opts.maxEntries || Math.max(5000, maxFiles * 10)));
  const maxDepth = Math.max(0, Number(opts.maxDepth ?? 12));
  const out = [];
  const queue = [{ filePath: rootPath, depth: 0 }];
  const visitedDirectories = new Set();
  let visitedEntries = 0;
  let truncated = false;
  while (queue.length && out.length < maxFiles && visitedEntries < maxEntries) {
    const { filePath: current, depth } = queue.shift();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let realPath;
      try {
        realPath = fs.realpathSync(current);
      } catch {
        continue;
      }
      if (visitedDirectories.has(realPath)) continue;
      visitedDirectories.add(realPath);
      const remainingEntries = maxEntries - visitedEntries;
      const scan = readDirectoryEntriesBounded(current, remainingEntries);
      visitedEntries += scan.scannedCount;
      if (scan.truncated) truncated = true;
      const entries = scan.entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const name = entry.name;
        if (name === "node_modules" || name === ".git" || name === "dist" || name === "release") continue;
        if (entry.isSymbolicLink()) continue;
        const child = path.join(current, name);
        if (entry.isDirectory()) {
          if (depth < maxDepth) queue.push({ filePath: child, depth: depth + 1 });
          else truncated = true;
        } else if (entry.isFile() && out.length < maxFiles) {
          out.push(child);
        } else if (entry.isFile()) {
          truncated = true;
        }
      }
    } else if (stat.isFile()) {
      visitedEntries += 1;
      out.push(current);
    }
  }
  if (queue.length) truncated = true;
  out.truncated = truncated;
  out.visitedEntries = visitedEntries;
  out.maxDepth = maxDepth;
  return out;
}

module.exports = {
  candidateFiles,
  contentHash,
  readDirectoryEntriesBounded,
  readTextFile,
};
