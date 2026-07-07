#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  categorySummaryKey,
  groupToolsByCategory,
  processGroupSummary,
} from "../src/renderer/modules/turn-process-summary-model.js";
import {
  categorySummaryKey as compatCategorySummaryKey,
  groupToolsByCategory as compatGroupToolsByCategory,
  processGroupSummary as compatProcessGroupSummary,
} from "../src/renderer/modules/turn-process-layout.js";

const tools = [
  { id: "r1", name: "Read" },
  { id: "w1", name: "Write" },
  { id: "r2", name: "read" },
  { id: "b1", name: "Bash" },
  { id: "x1", name: "Mystery" },
];
const groups = groupToolsByCategory(tools);
assert.deepEqual([...groups.keys()], ["read", "write", "command", "other"]);
assert.deepEqual(groups.get("read").map((entry) => entry.id), ["r1", "r2"]);
assert.deepEqual(compatGroupToolsByCategory(tools).get("read").map((entry) => entry.id), ["r1", "r2"]);

assert.deepEqual(categorySummaryKey("read", 2), ["timeline.summaryRead", { count: 2 }]);
assert.deepEqual(categorySummaryKey("write", 1), ["timeline.summaryWrite", { count: 1 }]);
assert.deepEqual(categorySummaryKey("search", 1), ["timeline.summarySearch", { count: 1 }]);
assert.deepEqual(categorySummaryKey("command", 1), ["timeline.summaryCommand", { count: 1 }]);
assert.deepEqual(categorySummaryKey("web", 1), ["timeline.summaryWeb", { count: 1 }]);
assert.deepEqual(categorySummaryKey("agent", 1), ["timeline.summaryAgent", { count: 1 }]);
assert.deepEqual(categorySummaryKey("other", 3), ["timeline.summaryOther", { count: 3 }]);
assert.deepEqual(compatCategorySummaryKey("agent", 4), ["timeline.summaryAgent", { count: 4 }]);

const translate = (key, params = {}) => `${key}:${params.count ?? ""}`;
assert.equal(processGroupSummary([{ id: "t1" }, { id: "t2" }], [{ id: "n1" }], translate), "timeline.stepsCompleted:2 · timeline.processNotices:1");
assert.equal(processGroupSummary([], [{ id: "n1" }], translate), "timeline.processNotices:1");
assert.equal(processGroupSummary([], [], translate), "");
assert.equal(compatProcessGroupSummary([{ id: "t1" }], [], translate), "timeline.stepsCompleted:1");

for (const file of [
  "turn-process-layout.js",
  "turn-grouped-tools.js",
  "turn-process-group.js",
  "turn-live-process-patch.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/turn-process-summary-model\.js"/, `${file} should import process summary helpers from turn-process-summary-model`);
}

const layoutSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-layout.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(layoutSource, /function groupToolsByCategory\s*\(/);
assert.doesNotMatch(layoutSource, /function processGroupSummary\s*\(/);
assert.doesNotMatch(layoutSource, /function categorySummaryKey\s*\(/);

console.log("turn-process-summary-model: ok");
