#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const userFacingFiles = [
  "src/main/turn-orchestrator.js",
  "src/main/memory-registry.js",
  "src/main/context-os-scorecard.js",
  "src/main/subagent-isolation-policy.js",
  "src/main/runtime/opencode-model-config.js",
  "src/main/runtime/opencode-sdk-session.js",
  "src/renderer/i18n/locales/zh-CN.json",
  "src/renderer/i18n/locales/en.json",
];

const forbidden = [
  "OpenCode 子代理",
  "OpenCode context",
  "OpenCode-native",
  "OpenCode needs",
  "OpenCode SDK client",
];

for (const rel of userFacingFiles) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const phrase of forbidden) {
    assert.equal(
      text.includes(phrase),
      false,
      `${rel} must not expose underlying runtime brand phrase: ${phrase}`,
    );
  }
}

console.log("user-facing-copy: ok");
