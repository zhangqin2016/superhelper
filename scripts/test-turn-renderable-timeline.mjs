#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getRenderableTimeline,
  resolveNoticeDetail,
} from "../src/renderer/modules/turn-renderable-timeline.js";
import {
  getRenderableTimeline as compatGetRenderableTimeline,
  resolveNoticeDetail as compatResolveNoticeDetail,
} from "../src/renderer/modules/turn-timeline.js";

const renderable = getRenderableTimeline({
  timeline: [
    { kind: "text", id: "text_1", text: "before tool" },
    { kind: "notice", id: "hidden-progress", code: "thinkingProgress", detail: "Working" },
    { kind: "notice", id: "hidden-tokens", detail: "1.2k tokens" },
    { kind: "notice", id: "visible-notice", code: "custom", detail: "Visible" },
    { kind: "tool", id: "tool_1", name: "Read", status: "done" },
    { kind: "text", id: "text_2", text: "final answer" },
  ],
});

assert.deepEqual(
  renderable.map((entry) => entry.id),
  ["text_1", "visible-notice", "tool_1"],
  "renderable timeline should keep interleaved prose and hide final-answer/noise entries",
);

const legacy = getRenderableTimeline({
  startedAt: 1,
  thinkingText: " legacy thought ",
  tools: [{ id: "tool_legacy", name: "Bash", input: { command: "npm test" } }],
});
assert.deepEqual(legacy.map((entry) => entry.kind), ["thinking", "tool"]);
assert.equal(legacy[1].preview, "Bash npm test");

assert.equal(resolveNoticeDetail({ code: "turnSteered", detail: "prefer concise" }), "message.steerBadge: prefer concise");
assert.equal(compatResolveNoticeDetail({ code: "turnSteered", detail: "prefer concise" }), "message.steerBadge: prefer concise");
assert.deepEqual(compatGetRenderableTimeline({ timeline: [{ kind: "text", id: "final", text: "done" }] }), []);

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-renderable-timeline\.js"/);
assert.doesNotMatch(timelineSource, /function filterRenderableTimeline\s*\(/);
assert.doesNotMatch(timelineSource, /function resolveNoticeDetail\s*\(/);

console.log("turn-renderable-timeline: ok");
