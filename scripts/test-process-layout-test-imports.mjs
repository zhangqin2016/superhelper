#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./test-process-summary.mjs", import.meta.url), "utf8");
assert.doesNotMatch(
  source,
  /src\/renderer\/modules\/turn-process-layout\.js/,
  "process summary behavior test should import the focused summary model",
);
assert.match(source, /src\/renderer\/modules\/turn-process-summary-model\.js/);

for (const file of [
  "test-turn-narrative-policy.mjs",
  "test-turn-process-layout.mjs",
  "test-turn-process-render-view.mjs",
  "test-turn-process-summary-model.mjs",
  "test-turn-process-timeline-model.mjs",
  "test-turn-process-view-model.mjs",
  "test-turn-tool-model.mjs",
]) {
  const compatSource = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  assert.match(
    compatSource,
    /src\/renderer\/modules\/turn-process-layout\.js|turn-process-layout\.js/,
    `${file} should keep explicit process-layout compatibility coverage`,
  );
}

console.log("process-layout-test-imports: ok");
