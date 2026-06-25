#!/usr/bin/env node

import {
  classifyToolCategory,
  resolveAssistantStreamText,
  shouldShowNarrative,
  shouldShowFinal,
  shouldCollapseProcessGroups,
  textMatchesFileToolBody,
  partitionTimeline,
  resolveFinalText,
  collapseRepeatedReadTools,
} from "../src/renderer/modules/turn-process-layout.js";
import { buildTimelineFromLegacy, getRenderableTimeline } from "../src/renderer/modules/turn-timeline.js";

if (classifyToolCategory("Write") !== "write") {
  throw new Error("classifyToolCategory Write failed");
}
if (classifyToolCategory("Bash") !== "command") {
  throw new Error("classifyToolCategory Bash failed");
}

const writeBody = "function hello() {\n  return 1;\n}";
const liveTurn = {
  assistantText: writeBody,
  final: {
    type: "turn.completed",
    payload: { assistant: "已写入文件。", resultFromCli: true },
  },
  tools: new Map([
    ["w1", {
      id: "w1",
      name: "Write",
      input: { file_path: "a.js", content: writeBody },
      status: "done",
    }],
  ]),
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

if (shouldShowNarrative(liveTurn)) {
  throw new Error("narrative should be hidden when duplicating write content");
}
if (shouldShowFinal(liveTurn)) {
  throw new Error("short write-only ack should not show final block");
}
if (!textMatchesFileToolBody(writeBody, liveTurn)) {
  throw new Error("dedup should detect write body match");
}

const multiToolTurn = {
  timeline: [
    { kind: "tool", id: "r1", name: "Read", input: { file_path: "a.js" }, status: "done" },
    { kind: "tool", id: "b1", name: "Bash", input: { command: "npm test" }, status: "done" },
  ],
  final: { type: "turn.completed", payload: { assistant: "Tests passed.", resultFromCli: true } },
};

if (!shouldCollapseProcessGroups(multiToolTurn, true)) {
  throw new Error("sealed multi-tool turn should collapse process groups");
}
if (shouldCollapseProcessGroups(multiToolTurn, false)) {
  throw new Error("live turn should not collapse process groups");
}

const { tools, notices } = partitionTimeline(multiToolTurn.timeline);
if (tools.length !== 2 || notices.length !== 0) {
  throw new Error("partitionTimeline failed");
}

const ackTurn = {
  timeline: [{
    kind: "tool",
    id: "w1",
    name: "Write",
    input: { file_path: "b.js", content: "export const x = 1;" },
    status: "done",
  }],
  final: { type: "turn.completed", payload: { assistant: "Done.", resultFromCli: true } },
  assistantText: "Done.",
};
if (!resolveFinalText(ackTurn)) {
  throw new Error("resolveFinalText should return ack text");
}

const stalledTurn = {
  assistantText: "让我分析提交验证逻辑，找出为什么填了还报必填项缺失。",
  final: {
    type: "turn.stalled",
    payload: {
      assistant: "让我分析提交验证逻辑，找出为什么填了还报必填项缺失。",
    },
  },
  timeline: [
    { kind: "tool", id: "r1", name: "Read", input: { file_path: "a.ts" }, status: "done" },
  ],
};
if (shouldShowFinal(stalledTurn)) {
  throw new Error("stalled CLI turn must not show work-result card");
}
if (!shouldShowNarrative(stalledTurn)) {
  throw new Error("stalled CLI assistant_text should stay visible in narrative");
}
if (resolveAssistantStreamText(stalledTurn) !== stalledTurn.final.payload.assistant) {
  throw new Error("resolveAssistantStreamText must prefer committed CLI assistant payload");
}

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
if (!shouldShowFinal(completedReportTurn)) {
  throw new Error("completed CLI turn with assistant result should show work-result card");
}
if (shouldShowNarrative(completedReportTurn)) {
  throw new Error("completed turn should not duplicate assistant text in narrative");
}

const idleCompletedTurn = {
  final: {
    type: "turn.completed",
    payload: { assistant: "这是宿主 idle 兜底，不是 CLI result。" },
  },
};
if (shouldShowFinal(idleCompletedTurn)) {
  throw new Error("turn.completed without resultFromCli must not show work-result card");
}
if (!shouldShowNarrative(idleCompletedTurn)) {
  throw new Error("idle-completed turn should keep assistant text in narrative");
}

// Interleaved block rendering: the bubble shows only the LAST prose block;
// earlier prose stays in the timeline. A final override (e.g. injected error
// text) that is not the streamed aggregation must still win the bubble.
const interleavedTurn = {
  assistantText: "先看下文件。结论：没有问题。",
  timeline: [
    { kind: "text", id: "text_1", ts: 1, text: "先看下文件。", status: "done" },
    { kind: "tool", id: "t1", ts: 2, name: "Read", input: { file_path: "a.js" }, status: "done", preview: "Read a.js" },
    { kind: "text", id: "text_2", ts: 3, text: "结论：没有问题。", status: "streaming" },
  ],
};
if (resolveAssistantStreamText(interleavedTurn) !== "结论：没有问题。") {
  throw new Error(`bubble must show only the last prose block: ${resolveAssistantStreamText(interleavedTurn)}`);
}
const renderable = getRenderableTimeline(interleavedTurn);
const renderableKinds = renderable.map((entry) => `${entry.kind}:${entry.id}`).join(",");
if (renderableKinds !== "text:text_1,tool:t1") {
  throw new Error(`timeline must keep earlier prose and drop the bubble block: ${renderableKinds}`);
}

const sealedAggregation = {
  ...interleavedTurn,
  final: { type: "turn.completed", payload: { assistant: "先看下文件。结论：没有问题。" } },
};
if (resolveAssistantStreamText(sealedAggregation) !== "结论：没有问题。") {
  throw new Error("sealed aggregation must not re-duplicate earlier prose in the bubble");
}

const errorOverride = {
  ...interleavedTurn,
  final: { type: "turn.failed", payload: { assistant: "连接已重置，请重新发送。" } },
};
if (resolveAssistantStreamText(errorOverride) !== "连接已重置，请重新发送。") {
  throw new Error("an injected final message must override the streamed prose");
}

// TodoWrite plans degrade safely: unknown statuses become pending, partial
// streamed JSON parses when complete and yields nothing when truncated.
import { isTodoTool, parseTodoEntries } from "../src/renderer/modules/turn-process-layout.js";

if (!isTodoTool("TodoWrite") || isTodoTool("Write")) {
  throw new Error("isTodoTool must match only the todo tool");
}
const todos = parseTodoEntries({
  name: "TodoWrite",
  input: { todos: [
    { content: "读取配置", status: "completed" },
    { content: "修改代码", status: "in_progress" },
    { content: "跑测试", status: "weird-status" },
    { content: "  ", status: "pending" },
  ] },
});
if (todos.length !== 3) {
  throw new Error(`empty items must drop, got ${todos.length}`);
}
if (todos[0].status !== "completed" || todos[1].status !== "in_progress" || todos[2].status !== "pending") {
  throw new Error(`status normalization failed: ${JSON.stringify(todos)}`);
}
const fromPartial = parseTodoEntries({
  name: "TodoWrite",
  input: {},
  partialJson: '{"todos":[{"content":"a","status":"pending"}]}',
});
if (fromPartial.length !== 1 || fromPartial[0].content !== "a") {
  throw new Error("complete partialJson must parse");
}
if (parseTodoEntries({ name: "TodoWrite", partialJson: '{"todos":[{"con' }).length !== 0) {
  throw new Error("truncated partialJson must yield no items");
}

const repeatedReads = collapseRepeatedReadTools([
  { kind: "tool", id: "r1", name: "Read", input: { file_path: "a.js" }, status: "done" },
  { kind: "tool", id: "r2", name: "read", input: { file_path: "b.js" }, status: "done" },
  { kind: "tool", id: "r3", name: "Read", input: { file_path: "c.js" }, status: "done" },
  { kind: "tool", id: "b1", name: "Bash", input: { command: "npm test" }, status: "done" },
]);
if (repeatedReads.length !== 2 || repeatedReads[0].kind !== "toolGroup" || repeatedReads[0].tools.length !== 3) {
  throw new Error(`three consecutive reads should collapse into one group: ${JSON.stringify(repeatedReads)}`);
}
if (partitionTimeline(repeatedReads).tools.length !== 2) {
  throw new Error("partitionTimeline should count toolGroup as a process tool");
}
const twoReads = collapseRepeatedReadTools([
  { kind: "tool", id: "r1", name: "Read", status: "done" },
  { kind: "tool", id: "r2", name: "Read", status: "done" },
]);
if (twoReads.length !== 1 || twoReads[0].kind !== "toolGroup" || twoReads[0].tools.length !== 2) {
  throw new Error(`two repeated reads should collapse without hiding details: ${JSON.stringify(twoReads)}`);
}
const separatedReads = collapseRepeatedReadTools([
  { kind: "tool", id: "r1", name: "Read", status: "done" },
  { kind: "text", id: "text_1", text: "progress" },
  { kind: "tool", id: "r2", name: "Read", status: "done" },
  { kind: "tool", id: "r3", name: "Read", status: "done" },
  { kind: "tool", id: "r4", name: "Read", status: "running" },
]);
if (separatedReads.length !== 3 || separatedReads[2].kind !== "toolGroup" || separatedReads[2].status !== "running") {
  throw new Error(`only consecutive reads should group and preserve running status: ${JSON.stringify(separatedReads)}`);
}

console.log("turn-process-layout: ok");
