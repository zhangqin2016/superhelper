#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-pack-location-"));
const userData = path.join(tmp, "user-data");
const externalRoot = path.join(tmp, "external-dependencies");
const secondRoot = path.join(tmp, "second-external-dependencies");
delete process.env.LILY_RUNTIME_PACK_ROOT;
process.env.LILY_USER_DATA_DIR = userData;

try {
  const location = require("../src/main/runtime-pack-location.js");

  const initial = location.getRuntimePackLocation();
  assert.equal(initial.ok, true);
  assert.equal(initial.root, userData, "default dependency root should be userData");
  assert.equal(initial.packsRoot, path.join(userData, "runtime-packs"));
  assert.equal(initial.statePath, path.join(userData, "runtime-packs.json"));
  assert.equal(initial.isDefault, true);
  assert.equal(initial.messageDbPath, path.join(userData, "messages.db"), "message DB path must remain in userData");

  const selected = location.setRuntimePackLocation(externalRoot);
  assert.equal(selected.ok, true);
  assert.equal(selected.root, externalRoot);
  assert.equal(selected.packsRoot, path.join(externalRoot, "runtime-packs"));
  assert.equal(selected.statePath, path.join(externalRoot, "runtime-packs.json"));
  assert.equal(selected.isDefault, false);
  assert(fs.existsSync(externalRoot), "selected dependency root should be created");
  assert(fs.existsSync(path.join(userData, "runtime-pack-root.json")), "root pointer should live in userData");
  assert.equal(location.getRuntimePackLocation().root, externalRoot, "configured dependency root should persist through config reader");
  assert.equal(location.getRuntimePackLocation().messageDbPath, path.join(userData, "messages.db"), "changing dependency root must not move messages");

  const fallbackPackDir = path.join(externalRoot, "runtime-packs", "rapidocr");
  fs.mkdirSync(fallbackPackDir, { recursive: true });
  fs.writeFileSync(
    path.join(externalRoot, "runtime-packs.json"),
    JSON.stringify({ schemaVersion: 1, installed: { rapidocr: { source: "artifact", version: "3.3.0" } } }),
    "utf8",
  );
  const movedAgain = location.setRuntimePackLocation(secondRoot);
  assert.equal(movedAgain.ok, true);
  assert.equal(movedAgain.root, secondRoot);
  assert.deepEqual(movedAgain.fallbackRoots, [externalRoot], "previous selected dependency root should remain as fallback");
  const packs = require("../src/main/runtime-packs.js");
  assert(
    packs.effectivePackEntries().some((entry) => entry.id === "rapidocr" && entry.dir === fallbackPackDir),
    "packs installed under the previous selected root should remain usable after choosing a new root",
  );

  const reset = location.resetRuntimePackLocation();
  assert.equal(reset.ok, true);
  assert.equal(reset.root, userData);
  assert.equal(reset.isDefault, true);
  assert.deepEqual(
    reset.fallbackRoots,
    [secondRoot, externalRoot],
    "reset should keep previous external dependency roots as fallback so capabilities do not disappear",
  );
  assert(fs.existsSync(path.join(userData, "runtime-pack-root.json")), "reset should keep a pointer file when fallback roots exist");
  assert(
    packs.effectivePackEntries().some((entry) => entry.id === "rapidocr" && entry.dir === fallbackPackDir),
    "resetting to the default install root should not hide packs installed under previous external roots",
  );

  fs.rmSync(secondRoot, { recursive: true, force: true });
  assert.deepEqual(
    location.getRuntimePackLocation().fallbackRoots,
    [externalRoot],
    "missing fallback dependency roots should be hidden from the current location state",
  );

  process.env.LILY_RUNTIME_PACK_ROOT = path.join(tmp, "env-root");
  const envLocked = location.setRuntimePackLocation(path.join(tmp, "ignored-root"));
  assert.equal(envLocked.ok, false);
  assert.equal(envLocked.error, "RUNTIME_PACK_ROOT_ENV_LOCKED");
  assert.equal(location.getRuntimePackLocation().root, path.join(tmp, "env-root"), "env override should win over pointer file");
} finally {
  delete process.env.LILY_RUNTIME_PACK_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("runtime-pack-location: ok");
