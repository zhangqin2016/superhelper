#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { appendTimelineNotice } from "../src/renderer/modules/turn-notice-timeline.js";
import { appendTimelineNotice as compatAppendTimelineNotice } from "../src/renderer/modules/turn-timeline.js";

const hidden = { timeline: [] };
appendTimelineNotice(hidden, { code: "thinkingProgress", detail: "Working", panel: true }, 1);
appendTimelineNotice(hidden, { code: "usage", detail: "1.2k tokens", panel: true }, 2);
appendTimelineNotice(hidden, { code: "apiRetry", detail: "Retrying", panel: false }, 3);
assert.deepEqual(hidden.timeline, []);

const progress = { timeline: [] };
appendTimelineNotice(progress, {
  code: "taskProgress",
  detail: "Uploading",
  progress: { current: 1, total: 2 },
  panel: true,
}, 10);
appendTimelineNotice(progress, {
  code: "taskCompleted",
  detail: "Upload complete",
  panel: true,
  replace: true,
  replacesCode: "taskProgress",
  done: true,
}, 20);
assert.equal(progress.timeline.length, 1);
assert.equal(progress.timeline[0].code, "taskCompleted");
assert.equal(progress.timeline[0].detail, "Upload complete");
assert.equal(progress.timeline[0].done, true);
assert.equal(progress.timeline[0].ts, 20);

const compat = { timeline: [] };
compatAppendTimelineNotice(compat, { code: "apiRetry", detail: "Retrying", panel: true }, 30);
assert.equal(compat.timeline[0].detail, "Retrying");

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-notice-timeline\.js"/);
assert.doesNotMatch(timelineSource, /function appendTimelineNotice\s*\(/);

console.log("turn-notice-timeline: ok");
