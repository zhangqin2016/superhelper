#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  appendTimelineText,
  closeOpenThinkingBlocks,
  closeStreamingBlocks,
  upsertTimelineThinking,
} from "../src/renderer/modules/turn-streaming-blocks.js";
import {
  appendTimelineText as compatAppendTimelineText,
  upsertTimelineThinking as compatUpsertTimelineThinking,
} from "../src/renderer/modules/turn-timeline.js";

const turn = {};
appendTimelineText(turn, "hello", 1);
upsertTimelineThinking(turn, " think", 2);
upsertTimelineThinking(turn, " more", 3);
appendTimelineText(turn, " answer", 4);

assert.deepEqual(
  turn.timeline.map((entry) => `${entry.kind}:${entry.status}:${entry.text}`),
  ["text:done:hello", "thinking:done: think more", "text:streaming: answer"],
  "text and thinking blocks should seal each other while preserving order",
);

closeStreamingBlocks(turn, 5, ["text"]);
assert.equal(turn.timeline.at(-1).status, "done");
assert.equal(turn.timeline.at(-1).ts, 5);

const thinkingTurn = {};
upsertTimelineThinking(thinkingTurn, "first", 10);
closeOpenThinkingBlocks(thinkingTurn, 11);
upsertTimelineThinking(thinkingTurn, "second", 12);
assert.deepEqual(thinkingTurn.timeline.map((entry) => entry.id), ["think_1", "think_2"]);

const compatTurn = {};
compatAppendTimelineText(compatTurn, "hello", 1);
compatUpsertTimelineThinking(compatTurn, "think", 2);
assert.deepEqual(compatTurn.timeline.map((entry) => entry.kind), ["text", "thinking"]);

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-streaming-blocks\.js"/);
assert.doesNotMatch(timelineSource, /function upsertTimelineThinking\s*\(/);
assert.doesNotMatch(timelineSource, /function appendTimelineText\s*\(/);
assert.doesNotMatch(timelineSource, /function closeStreamingBlocks\s*\(/);

console.log("turn-streaming-blocks: ok");
