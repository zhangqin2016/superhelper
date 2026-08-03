#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanSettingsFile, removeKnownTestFixtures } from "./ops/cleanup-model-test-fixtures.mjs";

const legitimate = {
  id: "custom-secret-model-company",
  label: "Secret Model",
  model: "secret-model",
  baseUrl: "https://company.example.com/v1",
};
const fixture = {
  id: "custom-secret-model-3",
  label: "Secret Model",
  model: "secret-model",
  baseUrl: "https://llm.example.com",
};
const input = { activePresetId: fixture.id, customPresets: [legitimate, fixture], other: { keep: true } };
const cleaned = removeKnownTestFixtures(input);
assert.deepEqual(cleaned.settings.customPresets, [legitimate], "only an exact test fixture signature may be removed");
assert.equal(cleaned.settings.activePresetId, null, "a removed active fixture must not remain selected");
assert.deepEqual(cleaned.settings.other, { keep: true }, "unrelated settings must remain byte-equivalent in meaning");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-model-cleanup-"));
const file = path.join(dir, "model-settings.json");
const original = JSON.stringify(input);
fs.writeFileSync(file, original, "utf8");
const dryRun = cleanSettingsFile(file);
assert.equal(dryRun.applied, false);
assert.equal(fs.readFileSync(file, "utf8"), original, "dry run must not write the settings file");

const applied = cleanSettingsFile(file, { apply: true });
assert.equal(applied.applied, true);
assert.ok(applied.backupPath && fs.existsSync(applied.backupPath), "apply must retain a recoverable backup");
assert.equal(fs.readFileSync(applied.backupPath, "utf8"), original);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).customPresets, [legitimate]);

console.log("model-settings-fixture-cleanup: ok");
