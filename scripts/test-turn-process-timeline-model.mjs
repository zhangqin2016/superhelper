#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collapseRepeatedReadTools,
  partitionTimeline,
  shouldCollapseProcessGroups,
  timelineForProcessView,
} from "../src/renderer/modules/turn-process-timeline-model.js";
import {
  collapseRepeatedReadTools as compatCollapseRepeatedReadTools,
  shouldCollapseProcessGroups as compatShouldCollapseProcessGroups,
} from "../src/renderer/modules/turn-process-layout.js";

const multiToolTurn = {
  timeline: [
    { kind: "tool", id: "r1", name: "Read", status: "done" },
    { kind: "tool", id: "b1", name: "Bash", status: "done" },
  ],
};
assert.equal(shouldCollapseProcessGroups(multiToolTurn, true), true);
assert.equal(shouldCollapseProcessGroups(multiToolTurn, false), false);
assert.equal(compatShouldCollapseProcessGroups(multiToolTurn, true), true);

const liveTimeline = timelineForProcessView({
  timeline: [
    { kind: "notice", id: "n1", level: "info", detail: "info" },
    { kind: "notice", id: "n2", level: "progress", detail: "progress" },
    { kind: "tool", id: "r1", name: "Read", status: "done" },
  ],
}, false);
assert.deepEqual(liveTimeline.map((entry) => entry.id), ["n2", "r1"]);

const sealedTimeline = timelineForProcessView({
  timeline: [
    { kind: "notice", id: "n1", level: "info", detail: "info" },
    { kind: "notice", id: "n2", level: "progress", detail: "progress" },
    { kind: "tool", id: "r1", name: "Read", status: "done" },
  ],
}, true);
assert.deepEqual(sealedTimeline.map((entry) => entry.id), ["n1", "n2", "r1"]);

const repeatedReads = collapseRepeatedReadTools([
  { kind: "tool", id: "r1", name: "Read", input: { file_path: "a.js" }, status: "done" },
  { kind: "tool", id: "r2", name: "read", input: { file_path: "b.js" }, status: "done" },
  { kind: "tool", id: "r3", name: "Read", input: { file_path: "c.js" }, status: "done" },
  { kind: "tool", id: "b1", name: "Bash", input: { command: "npm test" }, status: "done" },
]);
assert.equal(repeatedReads.length, 2);
assert.equal(repeatedReads[0].kind, "toolGroup");
assert.equal(repeatedReads[0].tools.length, 3);
assert.equal(partitionTimeline(repeatedReads).tools.length, 2);
assert.deepEqual(compatCollapseRepeatedReadTools([{ kind: "tool", id: "r1", name: "Read" }, { kind: "tool", id: "r2", name: "Read" }])[0].tools.map((entry) => entry.id), ["r1", "r2"]);

const separatedReads = collapseRepeatedReadTools([
  { kind: "tool", id: "r1", name: "Read", status: "done" },
  { kind: "text", id: "text_1", text: "progress" },
  { kind: "tool", id: "r2", name: "Read", status: "done" },
  { kind: "tool", id: "r3", name: "Read", status: "failed" },
]);
assert.equal(separatedReads.length, 3);
assert.equal(separatedReads[2].kind, "toolGroup");
assert.equal(separatedReads[2].status, "failed");

const layoutSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-layout.js", import.meta.url),
  "utf8",
);
assert.match(layoutSource, /from "\.\/turn-process-timeline-model\.js"/);
assert.doesNotMatch(layoutSource, /function collapseRepeatedReadTools\s*\(/);
assert.doesNotMatch(layoutSource, /function canGroupReadTool\s*\(/);
assert.doesNotMatch(layoutSource, /function partitionTimeline\s*\(/);

console.log("turn-process-timeline-model: ok");
