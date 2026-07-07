#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildTimelineFromLegacy } from "../src/renderer/modules/turn-legacy-timeline.js";
import { buildTimelineFromLegacy as compatBuildTimelineFromLegacy } from "../src/renderer/modules/turn-timeline.js";

const legacy = buildTimelineFromLegacy({
  startedAt: 1,
  thinkingText: " legacy thought ",
  tools: new Map([
    ["t1", { id: "t1", name: "Bash", input: { command: "npm test" }, status: "done" }],
    ["missing", { name: "Read", input: { file_path: "skip.js" } }],
  ]),
  notices: [
    { ts: 2, payload: { notice: { code: "permissionDenied", level: "warning", panel: true, detail: "denied" } } },
    { notice: { code: "apiRetry", level: "warning", panel: false, detail: "hidden" } },
  ],
});

assert.deepEqual(
  legacy.map((entry) => entry.kind),
  ["thinking", "tool", "notice"],
  "legacy timeline should preserve thinking, valid tools, and panel notices",
);
assert.equal(legacy[0].id, "think_1");
assert.equal(legacy[0].text, "legacy thought");
assert.equal(legacy[1].preview, "Bash npm test");
assert.equal(legacy[1].status, "done");
assert.equal(legacy[2].ts, 2);
assert.equal(legacy[2].detail, "denied");
assert.equal(compatBuildTimelineFromLegacy({ startedAt: 1, thinkingText: "x" })[0].text, "x");

const arrayTools = buildTimelineFromLegacy({
  startedAt: 3,
  tools: [{ id: "r1", name: "Read", input: { file_path: "a.js" } }],
});
assert.equal(arrayTools[0].preview, "Read a.js");
assert.equal(arrayTools[0].ts, 3);

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-legacy-timeline\.js"/);
assert.doesNotMatch(timelineSource, /function buildTimelineFromLegacy\s*\(/);

console.log("turn-legacy-timeline: ok");
