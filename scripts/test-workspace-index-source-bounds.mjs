#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { candidateFiles } = require("../src/main/mcp/workspace-index-source.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-index-bounds-"));
try {
  fs.writeFileSync(path.join(tmp, "root.txt"), "root");
  const level1 = path.join(tmp, "level1");
  const level2 = path.join(level1, "level2");
  fs.mkdirSync(level2, { recursive: true });
  fs.writeFileSync(path.join(level1, "one.txt"), "one");
  fs.writeFileSync(path.join(level2, "two.txt"), "two");

  const depthBounded = candidateFiles(tmp, { maxDepth: 1, maxFiles: 20 });
  assert(depthBounded.includes(path.join(level1, "one.txt")));
  assert(!depthBounded.includes(path.join(level2, "two.txt")), "files beyond maxDepth are not traversed");
  assert.equal(depthBounded.truncated, true, "depth-limited traversal reports sampled coverage");

  const linked = path.join(tmp, "linked-level1");
  try {
    fs.symlinkSync(level1, linked, "dir");
    const symlinkSafe = candidateFiles(tmp, { maxDepth: 5, maxFiles: 20 });
    assert(!symlinkSafe.some((file) => file.startsWith(`${linked}${path.sep}`)), "symlink directories are not followed");
  } catch (err) {
    if (!["EPERM", "EACCES"].includes(err.code)) throw err;
  }

  const entryBounded = candidateFiles(tmp, { maxDepth: 5, maxFiles: 20, maxEntries: 2 });
  assert(entryBounded.length <= 2, "directory scanning has an independent visited-entry bound");
  assert.equal(entryBounded.truncated, true, "entry-limited traversal reports sampled coverage");

  console.log("workspace-index-source-bounds: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
