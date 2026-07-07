#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const allowedCompatTests = new Set([
  "test-turn-activity-policy.mjs",
  "test-turn-legacy-timeline.mjs",
  "test-turn-notice-timeline.mjs",
  "test-turn-process-activity-timeline.mjs",
  "test-turn-renderable-timeline.mjs",
  "test-turn-reset-timeline.mjs",
  "test-turn-streaming-blocks.mjs",
  "test-turn-tool-preview.mjs",
  "test-turn-tool-timeline.mjs",
]);

for (const file of [
  "test-process-summary.mjs",
  "test-session-runtime-store.mjs",
  "test-turn-narrative-policy.mjs",
  "test-turn-process-layout.mjs",
]) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /src\/renderer\/modules\/turn-timeline\.js/, `${file} should import focused timeline modules`);
}

for (const file of allowedCompatTests) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  assert.match(source, /src\/renderer\/modules\/turn-timeline\.js/, `${file} should keep explicit compatibility coverage`);
}

console.log("renderer-timeline-test-imports: ok");
