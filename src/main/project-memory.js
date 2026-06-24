"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_CHARS = 4_000;
const UTF8_BYTES_PER_CHAR_WINDOW = 4;
const cache = new Map();

function trimMemoryText(value, maxChars = DEFAULT_MAX_CHARS) {
  const text = String(value || "").trim();
  if (!text || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars - 1)) + "…", truncated: true };
}

function projectMemoryPath(projectPath) {
  if (!projectPath) return null;
  return path.join(projectPath, "memory", "MEMORY.md");
}

function readBoundedUtf8Prefix(filePath, { maxChars = DEFAULT_MAX_CHARS, fileSize = 0 } = {}) {
  const windowBytes = Math.min(
    Math.max(256, (Number(maxChars) + 16) * UTF8_BYTES_PER_CHAR_WINDOW),
    Math.max(0, Number(fileSize || 0)),
  );
  if (windowBytes <= 0) return { raw: "", bytesRead: 0 };
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(windowBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, windowBytes, 0);
    return {
      raw: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readProjectMemoryIndex(projectPath, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const filePath = projectMemoryPath(projectPath);
  if (!filePath) return null;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const key = `${filePath}:${maxChars}`;
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.value };
  }

  let bounded;
  try {
    bounded = readBoundedUtf8Prefix(filePath, { maxChars, fileSize: stat.size });
  } catch {
    return null;
  }
  const trimmed = trimMemoryText(bounded.raw, maxChars);
  const truncated = trimmed.truncated || bounded.bytesRead < stat.size;
  const value = {
    filePath,
    bytes: stat.size,
    bytesRead: bounded.bytesRead,
    mtimeMs: stat.mtimeMs,
    text: trimmed.text,
    truncated,
  };
  cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return { ...value };
}

module.exports = {
  readProjectMemoryIndex,
};
