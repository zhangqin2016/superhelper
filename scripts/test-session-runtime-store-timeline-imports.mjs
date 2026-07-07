#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/renderer/modules/session-runtime-store.js", import.meta.url),
  "utf8",
);

assert.doesNotMatch(source, /from "\.\/turn-timeline\.js"/);
for (const moduleName of [
  "turn-activity-policy",
  "turn-notice-timeline",
  "turn-process-activity-timeline",
  "turn-reset-timeline",
  "turn-streaming-blocks",
  "turn-tool-timeline",
]) {
  assert.match(source, new RegExp(`from "\\./${moduleName}\\.js"`), `${moduleName} should be imported directly`);
}

console.log("session-runtime-store-timeline-imports: ok");
