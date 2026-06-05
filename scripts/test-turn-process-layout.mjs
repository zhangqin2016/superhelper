#!/usr/bin/env node

import {
  classifyToolCategory,
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
    payload: { assistant: "已写入文件。" },
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
  final: { type: "turn.completed", payload: { assistant: "Tests passed." } },
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
  final: { type: "turn.completed", payload: { assistant: "Done." } },
  assistantText: "Done.",
};
if (!resolveFinalText(ackTurn)) {
  throw new Error("resolveFinalText should return ack text");
}

console.log("turn-process-layout: ok");
