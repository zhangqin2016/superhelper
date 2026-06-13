"use strict";

// Filesystem containment checks for IPC handlers that write or delete files.
// Renderer-supplied paths must never escape the project root — including via
// `..` traversal or symlinked directories, so containment is checked on
// realpaths, not lexical paths.

const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve `filePath` and prove it lives inside `rootPath`.
 * The file itself may not exist (delete/restore flows), but its parent
 * directory must — the parent's realpath is what defeats symlink escapes.
 *
 * @returns {string|null} the resolved absolute path, or null if the path
 *   escapes the root (or either side cannot be resolved).
 */
function resolveContainedPath(rootPath, filePath) {
  if (!rootPath || !filePath || typeof filePath !== "string") return null;
  let realRoot;
  try {
    realRoot = fs.realpathSync(rootPath);
  } catch {
    return null;
  }
  const resolved = path.resolve(realRoot, filePath);
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    return null;
  }
  const realTarget = path.join(realParent, path.basename(resolved));
  if (realTarget === realRoot) return null; // the root itself is not a file target
  return realTarget.startsWith(realRoot + path.sep) ? realTarget : null;
}

module.exports = { resolveContainedPath };
