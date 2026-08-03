#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = [
  { stem: "custom-secret-model", label: "Secret Model", model: "secret-model", baseUrl: "https://llm.example.com" },
  { stem: "custom-local-qwen", label: "Local Qwen", model: "/private/Qwen3-Next-80B-A3B-Instruct", baseUrl: "http://127.0.0.1:8000/v1" },
  { stem: "custom-explicit-anthropic", label: "Explicit Anthropic", model: "claude-custom", baseUrl: "https://proxy.example.com/custom" },
  { stem: "custom-profiled-custom", label: "Profiled Custom Renamed", model: "profiled-model", baseUrl: "https://profiled.example.com/v1" },
];

export function isKnownTestFixture(preset) {
  return FIXTURES.some((fixture) => (
    new RegExp(`^${fixture.stem}(?:-\\d+)?$`).test(String(preset?.id || ""))
    && preset?.label === fixture.label
    && preset?.model === fixture.model
    && preset?.baseUrl === fixture.baseUrl
  ));
}

export function removeKnownTestFixtures(settings) {
  const presets = Array.isArray(settings?.customPresets) ? settings.customPresets : [];
  const removed = presets.filter(isKnownTestFixture);
  const kept = presets.filter((preset) => !isKnownTestFixture(preset));
  const removedIds = new Set(removed.map((preset) => preset.id));
  return {
    settings: {
      ...settings,
      activePresetId: removedIds.has(settings?.activePresetId) ? null : settings?.activePresetId,
      customPresets: kept,
    },
    removed,
  };
}

export function cleanSettingsFile(settingsPath, { apply = false } = {}) {
  const original = fs.readFileSync(settingsPath, "utf8");
  const parsed = JSON.parse(original);
  const result = removeKnownTestFixtures(parsed);
  if (!apply || result.removed.length === 0) return { ...result, applied: false, backupPath: null };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${settingsPath}.pre-test-fixture-cleanup-${stamp}.bak`;
  const tempPath = path.join(path.dirname(settingsPath), `.${path.basename(settingsPath)}.${process.pid}.tmp`);
  const mode = fs.statSync(settingsPath).mode & 0o777;
  fs.writeFileSync(backupPath, original, { encoding: "utf8", mode });
  fs.writeFileSync(tempPath, `${JSON.stringify(result.settings, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(tempPath, settingsPath);
  return { ...result, applied: true, backupPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const settingsPath = process.argv.find((arg) => arg.startsWith("--file="))?.slice(7);
  if (!settingsPath) throw new Error("usage: cleanup-model-test-fixtures.mjs --file=<model-settings.json> [--apply]");
  const result = cleanSettingsFile(settingsPath, { apply: process.argv.includes("--apply") });
  console.log(JSON.stringify({
    applied: result.applied,
    removedCount: result.removed.length,
    removedIds: result.removed.map((preset) => preset.id),
    backupPath: result.backupPath,
  }, null, 2));
}
