#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resetTimelineFields } from "../src/renderer/modules/turn-reset-timeline.js";
import { resetTimelineFields as compatResetTimelineFields } from "../src/renderer/modules/turn-timeline.js";

const turn = {
  timeline: [{ kind: "tool", id: "t1" }],
  activityLabel: "Bash npm test",
  durationMs: 1200,
  totalCostUsd: 0.03,
};
resetTimelineFields(turn);
assert.deepEqual(turn, {
  timeline: [],
  activityLabel: null,
  durationMs: null,
  totalCostUsd: null,
});

const compatTurn = { timeline: [{ kind: "text" }], activityLabel: "Reading" };
compatResetTimelineFields(compatTurn);
assert.deepEqual(compatTurn.timeline, []);
assert.equal(compatTurn.activityLabel, null);

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-reset-timeline\.js"/);
assert.doesNotMatch(timelineSource, /function resetTimelineFields\s*\(/);

console.log("turn-reset-timeline: ok");
