#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildEvidenceReplayBundle } = require("../src/main/evidence-replay-bundle.js");

const bundle = buildEvidenceReplayBundle({
  turnId: "turn_1",
  tools: [
    { id: "tool_1", name: "Bash", status: "done", input: { command: "npm test" } },
    { id: "task_1", name: "Task", status: "done", input: { prompt: "audit auth flow" } },
    { id: "read_1", name: "Read", status: "done", input: { file_path: "a.js" }, parentToolUseId: "task_1" },
  ],
  fileChanges: [{
    toolId: "tool_2",
    fileName: "a.js",
    filePath: "/repo/a.js",
    status: "modified",
    originalContent: "const a = 1;\n",
    diff: [
      { type: "del", content: "const a = 1;" },
      { type: "add", content: "const a = 2;" },
    ],
    stats: { adds: 1, dels: 1 },
  }],
  artifacts: [{ id: "artifact_1", title: "Report", path: "/repo/report.md", mimeType: "text/markdown", bytes: 42 }],
  meta: { evidenceGate: { ok: false, reason: "coverage_claim_without_candidate_set" } },
});

assert.equal(bundle.schemaVersion, 1);
assert.equal(bundle.itemCount >= 7, true);
assert.equal(bundle.items.some((item) => item.kind === "tool" && item.replay.input.command === "npm test"), true);
assert.equal(bundle.items.some((item) => item.kind === "subagent_handoff" && item.replay.input.prompt === "audit auth flow"), true);
assert.equal(bundle.items.some((item) => item.kind === "subagent_child_tool" && item.replay.parentToolUseId === "task_1"), true);
assert.equal(bundle.items.some((item) => item.kind === "file_change" && item.replay.originalAvailable === true), true);
assert.equal(bundle.items.some((item) => item.kind === "artifact" && item.replay.path === "/repo/report.md"), true);
assert.equal(bundle.items.some((item) => item.kind === "evidence_gap"), true);

console.log("evidence-replay-bundle: ok");
