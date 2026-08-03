#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-empty-legacy-import-"));
process.env.LILY_USER_DATA_DIR = root;
process.env.LILY_HOME = root;
process.env.LILY_DOCUMENTS_DIR = root;
fs.writeFileSync(path.join(root, "sessions.legacy-backup.json"), JSON.stringify({ sessions: {} }), "utf8");

const require = createRequire(import.meta.url);
const legacyImport = require("../src/main/store/legacy-import.js");
const originalReadFileSync = fs.readFileSync;
let backupReads = 0;
fs.readFileSync = function countedRead(filePath, ...args) {
  if (path.resolve(String(filePath)) === path.join(root, "sessions.legacy-backup.json")) backupReads += 1;
  return originalReadFileSync.call(this, filePath, ...args);
};

try {
  for (const completedFlag of ["none", "done:0"]) {
    const store = {
      meta: () => completedFlag,
      count: () => 0,
      setMeta: () => { throw new Error("completed empty import must not be rewritten"); },
    };
    assert.deepEqual(legacyImport.importSession(store, "empty-session"), { imported: false, count: 0 });
  }
  assert.equal(backupReads, 0, "an explicitly empty imported session must not reparse the global legacy backup");
} finally {
  fs.readFileSync = originalReadFileSync;
}

console.log("legacy-empty-session-import: ok");
