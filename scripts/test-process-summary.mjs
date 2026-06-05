#!/usr/bin/env node

const { buildTimelineFromLegacy, toolPreview } = await import("../src/renderer/modules/turn-timeline.js");
const { processGroupSummary } = await import("../src/renderer/modules/turn-process-layout.js");

const liveTurn = {
  startedAt: 1000,
  tools: new Map([
    ["read_1", { id: "read_1", name: "Read", input: { file_path: "a.js" }, status: "done" }],
    ["bash_1", { id: "bash_1", name: "Bash", input: { command: "npm test" }, status: "done" }],
  ]),
};

const timeline = buildTimelineFromLegacy(liveTurn);
if (timeline.length !== 2) {
  throw new Error(`expected 2 tool timeline entries, got ${timeline.length}`);
}
if (toolPreview({ name: "Read", input: { file_path: "a.js" } }) !== "Read a.js") {
  throw new Error("tool preview failed");
}

const summary = processGroupSummary(
  [{ id: "read_1" }, { id: "bash_1" }],
  [{ detail: "notice" }],
  (key, params) => `${key}:${params?.count ?? 0}`,
);
if (!summary.includes("timeline.stepsCompleted:2")) {
  throw new Error(`process group summary failed: ${summary}`);
}

console.log("process-summary: ok");
