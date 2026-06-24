#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-memory-registry-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const {
  buildContextMemory,
  rankMemoryItems,
  selectMemoryItems,
} = require("../src/main/memory-registry.js");

const summary = {
  lastUserIntent: "继续实现 Context OS",
  lastAssistantResult: "已接入 OpenCode 原生 compaction",
  pendingTask: "把 memory 做成预算化注入",
  recentFiles: ["src/main/opencode-agent-session.js", "src/main/session-memory.js"],
  lastCompactedAt: "2026-06-25T10:00:00.000Z",
  compactionCount: 2,
  lastCompaction: {
    engineSessionId: "ses_1",
    summaryMessageId: "msg_summary",
  },
  recentTurnPointers: [{ turnId: "turn_1", engineMessageId: "msg_1" }],
  recentEvidenceGaps: [{
    reason: "coverage_claim_without_candidate_set",
    turnId: "turn_gap_1",
    userIntent: "彻底找出所有 session.idle 问题",
    assistantPreview: "已经找出全部 session.idle 问题。",
  }],
};

assert.equal(
  buildContextMemory({
    sessionSummary: { ...summary, lastCompactedAt: "", compactionCount: 0, recentEvidenceGaps: [] },
    project: { name: "lily-workbench", path: "/repo/lily" },
    turnPolicy: { rigor: "fast" },
  }).text,
  "",
  "ordinary fast turns avoid memory injection unless there is a specific continuity need",
);

const grounded = buildContextMemory({
  sessionSummary: summary,
  project: { name: "lily-workbench", path: "/repo/lily" },
  projectMemory: {
    filePath: "/repo/lily/memory/MEMORY.md",
    mtimeMs: 100,
    bytes: 200,
    text: "- [Context OS](context-os.md) — memory is retrieval, not proof",
    truncated: false,
  },
  workspaceDigest: "Directory structure:\n- src/ (12)\n- memory/ (4)",
  learnedConventions: "- 报告统一用宋体\n- 用户偏好中文结果",
  turnPolicy: { rigor: "grounded" },
});
assert.match(grounded.text, /Lily Memory Context/);
assert.match(grounded.text, /把 memory 做成预算化注入/);
assert.match(grounded.text, /OpenCode 原生 compaction/);
assert.match(grounded.text, /last compacted/);
assert.equal(grounded.items.some((item) => item.kind === "session_summary"), true);
assert.equal(grounded.items.some((item) => item.kind === "compaction_state"), true);
assert.equal(grounded.items.some((item) => item.kind === "evidence_gap"), true);
assert.equal(grounded.items.some((item) => item.kind === "project_memory"), true);
assert.equal(grounded.items.some((item) => item.kind === "workspace_digest"), true);
assert.equal(grounded.items.some((item) => item.kind === "learned_conventions"), true);
assert.equal(grounded.diagnostics.semanticIndex, "durable", "workspace memory ranking uses persisted semantic index when userData is available");
assert.equal(grounded.items.find((item) => item.kind === "project_memory")?.trust, "workspace_memory");
assert.equal(grounded.items.find((item) => item.kind === "project_memory")?.proof, false);
assert.equal(grounded.items.find((item) => item.kind === "session_summary")?.trust, "lily_session_memory");
assert.equal(grounded.items.find((item) => item.kind === "learned_conventions")?.trust, "user_learned_memory");
assert.equal(grounded.items.find((item) => item.kind === "learned_conventions")?.proof, false);
assert.deepEqual(
  grounded.items.find((item) => item.kind === "session_summary")?.sourcePointers?.[0],
  { type: "turn", turnId: "turn_1", engineMessageId: "msg_1" },
);
assert.equal(
  grounded.items.find((item) => item.kind === "evidence_gap")?.sourcePointers?.[0]?.turnId,
  "turn_gap_1",
);
assert.equal(
  grounded.items.find((item) => item.kind === "project_memory")?.sourcePointers?.[0]?.filePath,
  "/repo/lily/memory/MEMORY.md",
);
assert.equal(
  grounded.items.find((item) => item.kind === "workspace_digest")?.sourcePointers?.[0]?.filePath,
  "/repo/lily",
);
assert.match(grounded.text, /coverage_claim_without_candidate_set/);
assert.match(grounded.text, /Do not repeat unsupported claims/);
assert.match(grounded.text, /memory is retrieval, not proof/);
assert.match(grounded.text, /报告统一用宋体/);
assert.match(grounded.fingerprint, /^[a-f0-9]{64}$/);

const groundedAgain = buildContextMemory({
  sessionSummary: summary,
  project: { name: "lily-workbench", path: "/repo/lily" },
  projectMemory: {
    filePath: "/repo/lily/memory/MEMORY.md",
    mtimeMs: 100,
    bytes: 200,
    text: "- [Context OS](context-os.md) — memory is retrieval, not proof",
    truncated: false,
  },
  workspaceDigest: "Directory structure:\n- src/ (12)\n- memory/ (4)",
  learnedConventions: "- 报告统一用宋体\n- 用户偏好中文结果",
  turnPolicy: { rigor: "grounded" },
});
assert.equal(groundedAgain.fingerprint, grounded.fingerprint, "same selected memory has stable fingerprint");

const sourceChanged = buildContextMemory({
  sessionSummary: summary,
  project: { name: "lily-workbench", path: "/repo/lily" },
  projectMemory: {
    filePath: "/repo/lily/memory/MEMORY.md",
    mtimeMs: 200,
    bytes: 200,
    text: "- [Context OS](context-os.md) — memory is retrieval, not proof",
    truncated: false,
  },
  workspaceDigest: "Directory structure:\n- src/ (12)\n- memory/ (4)",
  learnedConventions: "- 报告统一用宋体\n- 用户偏好中文结果",
  turnPolicy: { rigor: "grounded" },
});
assert.notEqual(sourceChanged.fingerprint, grounded.fingerprint, "source version changes invalidate memory fingerprint");
assert.equal(
  sourceChanged.items.find((item) => item.kind === "project_memory")?.sourceVersion.includes("200"),
  true,
);

const disabledLearned = buildContextMemory({
  sessionSummary: summary,
  project: { name: "lily-workbench", path: "/repo/lily" },
  learnedConventions: "- 报告统一用宋体\n- 用户偏好中文结果",
  disabledKinds: ["learned_conventions"],
  turnPolicy: { rigor: "grounded" },
});
assert.equal(
  disabledLearned.items.some((item) => item.kind === "learned_conventions"),
  false,
  "disabled memory categories are filtered before budget selection",
);

const compactOnly = buildContextMemory({
  sessionSummary: summary,
  turnPolicy: { rigor: "fast", memoryBudget: { maxChars: 0, criticalMaxChars: 700 } },
  includeSessionSummary: false,
});
assert.match(compactOnly.text, /last compacted/);
assert.doesNotMatch(compactOnly.text, /把 memory 做成预算化注入/);
assert.equal(compactOnly.diagnostics.maxChars, 700, "fast turns use only critical memory budget when critical continuity exists");

const noCriticalFastMemory = buildContextMemory({
  sessionSummary: { ...summary, lastCompactedAt: "", compactionCount: 0, recentEvidenceGaps: [] },
  project: { name: "lily-workbench", path: "/repo/lily" },
  turnPolicy: { rigor: "fast", memoryBudget: { maxChars: 0, criticalMaxChars: 700 } },
});
assert.equal(noCriticalFastMemory.text, "", "fast turns with no critical memory inject nothing");
assert.equal(noCriticalFastMemory.diagnostics.maxChars, 0);

const selected = selectMemoryItems([
  { id: "low", priority: 1, text: "low ".repeat(100) },
  { id: "high", priority: 100, text: "important" },
], { maxChars: 40 });
assert.deepEqual(selected.map((item) => item.id), ["high"], "budget keeps highest-priority memory first");

const ranked = rankMemoryItems([
  { id: "reports", priority: 20, text: "回答金融报告时先给结论，再给依据" },
  { id: "runtime", priority: 20, text: "运行时问题先检查 OpenCode 原生能力" },
], "上海贝岭金融报告怎么写");
assert.equal(ranked.find((item) => item.id === "reports").relevance > ranked.find((item) => item.id === "runtime").relevance, true);
assert.equal(ranked.every((item) => typeof item.semanticRelevance === "number"), true, "memory ranking includes local vector relevance");

const budgeted = buildContextMemory({
  sessionSummary: summary,
  project: { name: "lily-workbench", path: "/repo/lily" },
  projectMemory: {
    filePath: "/repo/lily/memory/MEMORY.md",
    text: "project memory ".repeat(80),
    truncated: false,
  },
  turnPolicy: { rigor: "grounded", memoryBudget: { maxChars: 420 } },
});
assert.equal(budgeted.items.some((item) => item.kind === "evidence_gap"), true, "evidence gaps survive tight budgets");
assert.equal(budgeted.skipped.some((item) => item.id === "project_memory_index"), true, "budget diagnostics report skipped memory");
assert.equal(budgeted.diagnostics.rawCount > budgeted.diagnostics.selectedCount, true, "diagnostics expose selection pressure");
assert.equal(budgeted.diagnostics.maxChars, 420);
assert.equal(budgeted.items.every((item) => typeof item.size === "number"), true, "selected items carry size diagnostics");

console.log("memory-registry: ok");
