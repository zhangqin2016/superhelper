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
} from "../src/renderer/modules/turn-process-layout.js";
import { buildTimelineFromLegacy } from "../src/renderer/modules/turn-timeline.js";

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

console.log("turn-process-layout: ok");
