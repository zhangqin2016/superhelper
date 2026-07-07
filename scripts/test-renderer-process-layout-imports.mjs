#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const file of [
  "turn-live-process-patch.js",
  "turn-todo-entry.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from "\.\/turn-process-layout\.js"/, `${file} should import focused process modules`);
}

const livePatch = readFileSync(
  new URL("../src/renderer/modules/turn-live-process-patch.js", import.meta.url),
  "utf8",
);
assert.match(livePatch, /from "\.\/turn-process-timeline-model\.js"/);
assert.match(livePatch, /from "\.\/turn-process-view-model\.js"/);

const todoEntry = readFileSync(
  new URL("../src/renderer/modules/turn-todo-entry.js", import.meta.url),
  "utf8",
);
assert.match(todoEntry, /from "\.\/turn-tool-model\.js"/);

console.log("renderer-process-layout-imports: ok");
