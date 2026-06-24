#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-memory-preferences-"));
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => tempRoot, getName: () => "lily-test" } },
};

const {
  MEMORY_CATEGORIES,
  normalizeDisabledKinds,
  readMemoryPreferences,
  setMemoryCategoryEnabled,
  writeMemoryPreferences,
} = require("../src/main/memory-preferences.js");

try {
  assert(MEMORY_CATEGORIES.includes("learned_conventions"));
  assert.deepEqual(
    normalizeDisabledKinds(["learned_conventions", "bad", "learned_conventions"]),
    ["learned_conventions"],
  );
  assert.deepEqual(readMemoryPreferences("p1"), { schemaVersion: 1, disabledKinds: [] });

  writeMemoryPreferences("p1", { disabledKinds: ["project_memory", "bad"] });
  assert.deepEqual(readMemoryPreferences("p1").disabledKinds, ["project_memory"]);

  assert.deepEqual(
    setMemoryCategoryEnabled("p1", "project_memory", true).disabledKinds,
    [],
  );
  assert.deepEqual(
    setMemoryCategoryEnabled("p1", "evidence_gap", false).disabledKinds,
    ["evidence_gap"],
  );
  assert.equal(setMemoryCategoryEnabled("p1", "bad", false), null);

  console.log("memory-preferences: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
