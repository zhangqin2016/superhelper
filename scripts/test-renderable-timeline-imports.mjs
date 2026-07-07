#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const file of [
  "turn-narrative-policy.js",
  "turn-process-timeline-model.js",
  "turn-view-status.js",
  "turn-view-renderer.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/turn-renderable-timeline\.js"/, `${file} should import renderable timeline directly`);
  assert.doesNotMatch(source, /from "\.\/turn-timeline\.js"/, `${file} should not depend on the timeline barrel`);
}

const noticeSource = readFileSync(
  new URL("../src/renderer/modules/turn-notice-entry.js", import.meta.url),
  "utf8",
);
assert.match(noticeSource, /from "\.\/turn-renderable-timeline\.js"/);
assert.doesNotMatch(noticeSource, /from "\.\/turn-timeline\.js"/);

console.log("renderable-timeline-imports: ok");
