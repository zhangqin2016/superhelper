#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  answerBlockIndex,
  answerBlockText,
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
  // A block begins at its first visible character; the display trims the same
  // edge, and the full answer is archived separately, byte-for-byte.
  ["text:done:hello", "thinking:done: think more", "text:streaming:answer"],
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

// ------------------------------------------------ rule 1: separators are not blocks
// Measured on a real 396-tool turn: 28 of 35 stored text blocks were bare
// newlines emitted between tool calls, each sealed into its own entry and
// occupying the bounded archive window that real history needed.
{
  const turn = {};
  const tool = (id) => {
    closeStreamingBlocks(turn, 0);
    turn.timeline.push({ kind: "tool", id, status: "done" });
  };
  appendTimelineText(turn, "先看文件。", 1);
  tool("t1");
  appendTimelineText(turn, "\n\n", 2);
  tool("t2");
  appendTimelineText(turn, "\n\n\n\n", 3);
  appendTimelineText(turn, " \t\n", 4);
  tool("t3");
  appendTimelineText(turn, "\n\n批次 9 完成。", 5);
  assert.deepEqual(
    turn.timeline.map((entry) => entry.kind === "text" ? `text:${entry.text}` : `tool:${entry.id}`),
    ["text:先看文件。", "tool:t1", "tool:t2", "tool:t3", "text:批次 9 完成。"],
    "a separator between tools opens no block, and a real block starts at its first visible character",
  );
  assert.deepEqual(turn.timeline.filter((e) => e.kind === "text").map((e) => e.id), ["text_1", "text_2"]);

  const open = {};
  appendTimelineText(open, "第一段", 1);
  appendTimelineText(open, "\n\n", 2);
  appendTimelineText(open, "  第二段", 3);
  assert.equal(open.timeline.length, 1);
  assert.equal(open.timeline[0].text, "第一段\n\n  第二段", "whitespace inside an open block is the model's formatting, kept byte-for-byte");

  const thinking = {};
  upsertTimelineThinking(thinking, "想一下", 1);
  appendTimelineText(thinking, "\n", 2);
  upsertTimelineThinking(thinking, "再想", 3);
  assert.deepEqual(thinking.timeline.map((e) => `${e.kind}:${e.status}:${e.text}`), ["thinking:streaming:想一下再想"],
    "a line break is not an answer, so it does not end the thinking");
}

// ------------------------------------------------ rule 2: the answer is the last visible block
{
  const timeline = [
    { kind: "text", text: "进度旁白" },
    { kind: "tool", id: "t1" },
    { kind: "text", text: "最终回答" },
    { kind: "text", text: "\n\n" }, // archived before rule 1 existed
  ];
  assert.equal(answerBlockIndex(timeline), 2, "a blank trailing block is not the answer");
  assert.equal(answerBlockText(timeline), "最终回答");
  assert.equal(answerBlockText([{ kind: "tool", id: "t" }]), null);
  assert.equal(answerBlockText(undefined), null);

  const { getRenderableTimeline } = await import("../src/renderer/modules/turn-renderable-timeline.js");
  const { lastTimelineText } = await import("../src/renderer/modules/turn-narrative-policy.js");
  const process = getRenderableTimeline({ timeline });
  assert.deepEqual(process.filter((e) => e.kind === "text").map((e) => e.text), ["进度旁白"],
    "the answer is not shown a second time among the narration");
  assert.equal(lastTimelineText({ timeline }), "最终回答", "and the bubble shows it");
}

// ------------------------------------------------ one definition, both processes
{
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const main = require("../src/main/turn-timeline.js");
  const shared = await import("../src/shared/timeline-blocks.mjs");
  assert.equal(main.appendTimelineText, shared.appendTimelineText, "the main process archives with the same rules the renderer draws with");
  assert.equal(appendTimelineText, shared.appendTimelineText);
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  for (const rel of ["../src/main/turn-timeline.js", "../src/renderer/modules/turn-streaming-blocks.js"]) {
    assert.doesNotMatch(read(rel), /function (appendTimelineText|upsertTimelineThinking|closeStreamingBlocks)\s*\(/, `${rel} keeps no copy`);
  }
  for (const rel of ["../src/main/store/runtime-event-persistence.js", "../src/renderer/modules/turn-narrative-policy.js", "../src/renderer/modules/turn-renderable-timeline.js"]) {
    assert.match(read(rel), /answerBlock(Text|Index)/, `${rel} asks the shared rule which block is the answer`);
  }
}

console.log("turn-streaming-blocks: ok");
