#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyProcessEventToTimeline } from "../src/renderer/modules/turn-process-activity-timeline.js";
import { applyProcessEventToTimeline as compatApplyProcessEventToTimeline } from "../src/renderer/modules/turn-timeline.js";

const turn = {
  activityLabel: null,
  tools: [],
};
applyProcessEventToTimeline(turn, { rawSubtype: "status", event: { status: "Reading files" } }, 10);
assert.equal(turn.activityLabel, "Reading files");

applyProcessEventToTimeline(turn, { rawSubtype: "status", event: { status: "messageDelta" } }, 11);
assert.equal(turn.activityLabel, "Reading files", "internal engine labels must not replace a useful activity label");

const runningToolTurn = {
  activityLabel: "Bash npm test",
  tools: [{ id: "b1", name: "Bash", status: "running", input: { command: "npm test" } }],
};
applyProcessEventToTimeline(
  runningToolTurn,
  { rawSubtype: "status", event: { status: "Reading files" } },
  12,
);
assert.equal(runningToolTurn.activityLabel, "Bash npm test", "running tools stay the strongest activity signal");

const compatTurn = { activityLabel: null, tools: [] };
compatApplyProcessEventToTimeline(compatTurn, { event: { message: "Checking workspace" } }, 13);
assert.equal(compatTurn.activityLabel, "Checking workspace");

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-process-activity-timeline\.js"/);
assert.doesNotMatch(timelineSource, /function applyProcessEventToTimeline\s*\(/);

console.log("turn-process-activity-timeline: ok");
