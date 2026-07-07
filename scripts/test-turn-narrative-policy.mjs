#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveAssistantStreamText,
  resolveFinalText,
  shouldShowFinal,
  shouldShowNarrative,
  textMatchesFileToolBody,
} from "../src/renderer/modules/turn-narrative-policy.js";
import {
  shouldShowFinal as compatShouldShowFinal,
  shouldShowNarrative as compatShouldShowNarrative,
} from "../src/renderer/modules/turn-process-layout.js";
import { buildTimelineFromLegacy } from "../src/renderer/modules/turn-legacy-timeline.js";
import { getRenderableTimeline } from "../src/renderer/modules/turn-renderable-timeline.js";

const writeBody = "function hello() {\n  return 1;\n}";
const writeTurn = {
  assistantText: writeBody,
  final: {
    type: "turn.completed",
    payload: { assistant: "已写入文件。", resultFromCli: true },
  },
  timeline: buildTimelineFromLegacy({
    tools: new Map([
      ["w1", {
        id: "w1",
        name: "Write",
        input: { file_path: "a.js", content: writeBody },
        status: "done",
      }],
    ]),
  }),
};
assert.equal(textMatchesFileToolBody(writeBody, writeTurn), true);
assert.equal(shouldShowNarrative(writeTurn), false);
assert.equal(shouldShowFinal(writeTurn), false);
assert.equal(compatShouldShowFinal(writeTurn), shouldShowFinal(writeTurn));
assert.equal(compatShouldShowNarrative(writeTurn), shouldShowNarrative(writeTurn));

const completedReportTurn = {
  final: {
    type: "turn.completed",
    payload: { assistant: "## 结论\n\n根因是字段映射错误。", resultFromCli: true },
  },
  timeline: [
    { kind: "tool", id: "r1", name: "Read", input: { file_path: "a.ts" }, status: "done" },
    { kind: "tool", id: "r2", name: "Grep", input: { pattern: "validate" }, status: "done" },
  ],
};
assert.equal(shouldShowFinal(completedReportTurn), true);
assert.equal(shouldShowNarrative(completedReportTurn), false);

const idleCompletedTurn = {
  final: {
    type: "turn.completed",
    payload: { assistant: "这是宿主 idle 兜底，不是 CLI result。" },
  },
};
assert.equal(shouldShowFinal(idleCompletedTurn), false);
assert.equal(shouldShowNarrative(idleCompletedTurn), true);

const interleavedTurn = {
  assistantText: "先看下文件。结论：没有问题。",
  timeline: [
    { kind: "text", id: "text_1", ts: 1, text: "先看下文件。", status: "done" },
    { kind: "tool", id: "t1", ts: 2, name: "Read", input: { file_path: "a.js" }, status: "done", preview: "Read a.js" },
    { kind: "text", id: "text_2", ts: 3, text: "结论：没有问题。", status: "streaming" },
  ],
};
assert.equal(resolveAssistantStreamText(interleavedTurn), "结论：没有问题。");
assert.equal(getRenderableTimeline(interleavedTurn).map((entry) => `${entry.kind}:${entry.id}`).join(","), "text:text_1,tool:t1");
assert.equal(resolveFinalText({
  ...interleavedTurn,
  final: { type: "turn.completed", payload: { assistant: "先看下文件。结论：没有问题。" } },
}), "结论：没有问题。");
assert.equal(resolveAssistantStreamText({
  ...interleavedTurn,
  final: { type: "turn.failed", payload: { assistant: "连接已重置，请重新发送。" } },
}), "连接已重置，请重新发送。");

for (const file of [
  "turn-view-model.js",
  "turn-final-report.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/turn-narrative-policy\.js"/, `${file} should import narrative policy directly`);
}

const layoutSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-layout.js", import.meta.url),
  "utf8",
);
assert.match(layoutSource, /from "\.\/turn-narrative-policy\.js"/);
assert.doesNotMatch(layoutSource, /const CLI_ASSISTANT_TERMINALS\s*=/);
assert.doesNotMatch(layoutSource, /function lastTimelineText\s*\(/);

console.log("turn-narrative-policy: ok");
