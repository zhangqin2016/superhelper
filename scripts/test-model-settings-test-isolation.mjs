#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const externalUserData = mkdtempSync(path.join(os.tmpdir(), "lily-real-user-data-sentinel-"));
const settingsPath = path.join(externalUserData, "model-settings.json");
const sentinel = JSON.stringify({
  activePresetId: "real-user-model",
  customPresets: [{ id: "real-user-model", label: "Real user model" }],
});
writeFileSync(settingsPath, sentinel, "utf8");

const result = spawnSync(
  process.execPath,
  [path.join(scriptsDir, "test-model-settings-secret-storage.mjs")],
  {
    cwd: path.dirname(scriptsDir),
    env: {
      ...process.env,
      LILY_USER_DATA_DIR: externalUserData,
      LILY_HOME: externalUserData,
      LILY_DOCUMENTS_DIR: externalUserData,
    },
    encoding: "utf8",
  },
);

assert.equal(
  readFileSync(settingsPath, "utf8"),
  sentinel,
  "model settings tests must never mutate an inherited app user-data directory",
);
assert.equal(
  result.status,
  0,
  `isolated fixture test must complete successfully:\n${result.stdout}\n${result.stderr}`,
);

console.log("model-settings-test-isolation: ok");
