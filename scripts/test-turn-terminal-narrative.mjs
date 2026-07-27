#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  promoteTerminalNarrative,
} = require("../src/main/turn-terminal-narrative.js");
const {
  createTurnTerminalFinalizer,
} = require("../src/main/turn-terminal-finalizer.js");

const report = [
  "# Lily health report",
  "",
  "| Area | Status |",
  "| --- | --- |",
  "| Runtime | OK |",
  "| Tools | OK |",
  "",
  "The verification covered every required runtime and tool surface. ".repeat(7),
].join("\n").trim();
const closing = "All checklist items are complete.";
const terminalTimeline = [
  { kind: "text", id: "text_progress", text: "Starting the checks.", status: "done" },
  { kind: "tool", id: "read_1", name: "read", status: "done" },
  { kind: "text", id: "text_report", text: report, status: "done" },
  { kind: "tool", id: "todo_1", name: "TodoWrite", status: "done" },
  { kind: "thinking", id: "think_1", text: "Everything is complete.", status: "done" },
  { kind: "text", id: "text_closing", text: closing, status: "done" },
];

const promoted = promoteTerminalNarrative(
  terminalTimeline,
  `${terminalTimeline[0].text}${report}${closing}`,
);
assert.equal(promoted.promoted, true);
assert.equal(promoted.assistant, `${report}\n\n${closing}`);
assert.equal(
  promoted.timeline.filter((entry) => entry.kind === "text").length,
  2,
  "the report moves into the final narrative instead of remaining duplicated in process",
);
assert.equal(promoted.timeline.at(-1).text, `${report}\n\n${closing}`);
assert.equal(
  promoted.timeline.find((entry) => entry.id === "todo_1")?.name,
  "TodoWrite",
  "task metadata remains visible and unchanged",
);

const evidenceChangingTool = promoteTerminalNarrative([
  { kind: "text", id: "report", text: report, status: "done" },
  { kind: "tool", id: "read", name: "Read", status: "done" },
  { kind: "text", id: "correction", text: "The earlier result was incorrect.", status: "done" },
], "original");
assert.equal(evidenceChangingTool.promoted, false);
assert.equal(evidenceChangingTool.assistant, "original");

const shortProgress = promoteTerminalNarrative([
  { kind: "text", id: "progress", text: "Finished stage one.", status: "done" },
  { kind: "tool", id: "todo", name: "todowrite", status: "done" },
  { kind: "text", id: "answer", text: "Here is the final answer.", status: "done" },
], "baseline");
assert.equal(shortProgress.promoted, false, "ordinary progress must stay in the process timeline");
assert.equal(shortProgress.assistant, "baseline");

const malformed = promoteTerminalNarrative(null, "baseline");
assert.equal(malformed.promoted, false);
assert.equal(malformed.assistant, "baseline");

const state = {
  sessionId: "session_terminal_markdown",
  turnId: "turn_terminal_markdown",
  terminalEmitted: false,
  finalizing: false,
  phase: "streaming",
  tools: new Map([
    ["todo_1", { id: "todo_1", name: "TodoWrite", status: "done" }],
  ]),
  timeline: terminalTimeline.map((entry) => ({ ...entry })),
  assistantText: `${terminalTimeline[0].text}${report}${closing}`,
  thinkingText: "",
  contentBlocks: [],
  protocolUnknown: [],
  processEvents: [],
  notices: [],
  pendingPermissions: new Map(),
  pendingQuestions: new Map(),
  pendingHooks: new Map(),
  taskContract: null,
  pendingTaskContract: null,
  turnPolicy: null,
  evidenceLedger: null,
  inheritedEvidenceTools: [],
  taskRun: null,
  enginePayload: { rawText: "Run a complete health check", files: [] },
  currentPayload: { rawText: "Run a complete health check", files: [] },
};
const emitted = [];
let committedRecord = null;
const finalizer = createTurnTerminalFinalizer({
  ctx: {
    sessionManager: {
      findById: () => null,
      markTurnInputTerminal: () => {},
    },
  },
  getState: () => state,
  emit: (_sessionId, type, payload) => emitted.push({ type, payload }),
  turnArchive: {
    buildRecord: (_state, terminal, payload) => ({
      terminal,
      assistantText: payload.assistant,
      fileChanges: [],
      resultBlocks: [],
      meta: {},
    }),
    commit: (_sessionId, record) => {
      committedRecord = record;
      return { id: "message_terminal_markdown" };
    },
  },
  taskRunRuntime: { complete: () => {} },
  subagentRuntime: { clearAllWatches: () => {} },
});
await finalizer.finalize(state.sessionId, "turn.completed", {
  assistant: state.assistantText,
});
assert.equal(
  emitted.find((event) => event.type === "assistant.final")?.payload?.assistant,
  `${report}\n\n${closing}`,
  "the finalizer must emit the promoted Markdown, not only the post-Todo acknowledgement",
);
assert.equal(committedRecord?.assistantText, `${report}\n\n${closing}`);
assert.equal(committedRecord?.meta?.terminalNarrativePromoted, true);

console.log("turn-terminal-narrative: ok");
