"use strict";

const path = require("node:path");

/** zip-slip guard: a resolved entry path must stay inside the target dir. */
function safeJoin(targetDir, relPath) {
  const resolved = path.resolve(targetDir, relPath);
  const base = path.resolve(targetDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`UNSAFE_PATH: ${relPath}`);
  }
  return resolved;
}

module.exports = { safeJoin };
