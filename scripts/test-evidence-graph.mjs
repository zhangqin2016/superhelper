#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildEvidenceGraph } = require("../src/main/evidence-graph.js");

const graph = buildEvidenceGraph({
  turnId: "turn_1",
  terminal: "turn.completed",
  user: { text: "修复 bug" },
  tools: [
    { id: "tool_1", name: "Bash", status: "done", input: { command: "npm test" } },
    { id: "task_1", name: "Task", status: "done", input: { prompt: "audit auth flow" } },
    { id: "read_1", name: "Read", status: "done", input: { file_path: "a.js" }, parentToolUseId: "task_1" },
  ],
  fileChanges: [{ fileName: "a.js", filePath: "/repo/a.js", status: "modified" }],
  artifacts: [{ id: "artifact_1", title: "Report", type: "markdown", path: "/repo/report.md" }],
  meta: { evidenceGate: { ok: false, reason: "coverage_claim_without_candidate_set" } },
});

assert.equal(graph.schemaVersion, 1);
assert.equal(graph.nodes.some((item) => item.type === "turn" && item.id === "turn:turn_1"), true);
assert.equal(graph.nodes.some((item) => item.type === "tool" && item.label === "Bash"), true);
assert.equal(graph.nodes.some((item) => item.type === "subagent_handoff" && item.id === "subagent:task_1"), true);
assert.equal(graph.nodes.some((item) => item.type === "file_change" && item.data.filePath === "/repo/a.js"), true);
assert.equal(graph.nodes.some((item) => item.type === "artifact"), true);
assert.equal(graph.nodes.some((item) => item.type === "evidence_gap"), true);
assert.equal(graph.edges.some((item) => item.type === "used_tool"), true);
assert.equal(graph.edges.some((item) => item.type === "delegated_subagent"), true);
assert.equal(graph.edges.some((item) => item.type === "subagent_used_tool"), true);
assert.equal(graph.edges.some((item) => item.type === "changed_file"), true);

console.log("evidence-graph: ok");
