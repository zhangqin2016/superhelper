"use strict";

const fs = require("node:fs");

function readableFilePath(value) {
  const candidate = String(value || "");
  if (!candidate) return "";
  try {
    return fs.statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

// Staged files are stable transport snapshots. A readable original remains the
// authoritative source so edits made outside Lily are visible on later turns.
function resolveLiveFilePath(file = {}) {
  return readableFilePath(file.sourcePath) ||
    readableFilePath(file.path || file.filePath) ||
    String(file.sourcePath || file.path || file.filePath || "");
}

function withLiveFilePath(file = {}) {
  const livePath = resolveLiveFilePath(file);
  if (!livePath || livePath === file.path) return file;
  return {
    ...file,
    path: livePath,
    stagedFallbackPath: file.path || file.filePath || "",
  };
}

module.exports = {
  readableFilePath,
  resolveLiveFilePath,
  withLiveFilePath,
};
