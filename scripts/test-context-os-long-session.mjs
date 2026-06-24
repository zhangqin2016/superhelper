#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-context-os-long-"));
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => tempRoot, getName: () => "lily-test" } },
};

const { decideBackgroundCompaction } = require("../src/main/context-budget-manager.js");
const { buildContextMemory } = require("../src/main/memory-registry.js");
const {
  markContextMemoryInjected,
  markSessionCompacted,
  readSessionSummary,
  updateSessionSummaryFromRecord,
} = require("../src/main/session-memory.js");
const { appendLearnedConvention } = require("../src/main/learned-context.js");

try {
  appendLearnedConvention("p-long", "运行时问题先检查 OpenCode 原生能力");
  for (let i = 0; i < 120; i += 1) {
    updateSessionSummaryFromRecord("s-long", {
      turnId: `turn_${i}`,
      engineMessageId: `msg_${i}`,
      terminal: "turn.completed",
      user: { text: i === 80 ? "彻底检查 session.idle 串会话问题" : `继续 Context OS 第 ${i} 步` },
      assistantText: i === 80
        ? "已经找出全部 session.idle 问题。\n\n证据门槛：缺少候选集合。"
        : "ok",
      fileChanges: i % 20 === 0 ? [{ fileName: "src/main/turn-orchestrator.js" }] : [],
      meta: {
        engine: {
          promptChars: 2_000 + i * 100,
          estimatedPromptTokens: 500 + i * 25,
        },
        ...(i === 80
          ? {
              evidenceGate: {
                ok: false,
                reason: "coverage_claim_without_candidate_set",
              },
            }
          : {}),
      },
    });
  }

  let summary = readSessionSummary("s-long");
  assert.equal(summary.turnCount, 120, "long-session summary tracks turn count");
  assert.equal(summary.recentTurnPointers.length <= 8, true, "turn pointers stay bounded");
  assert.equal(summary.lastTurnId, "turn_119");
  assert.equal(summary.lastEngineMessageId, "msg_119");
  assert.equal(summary.lastEvidenceGap.reason, "coverage_claim_without_candidate_set");
  assert.equal(summary.maxEnginePromptTokens > 3_000, true, "prompt pressure is retained");

  const memory = buildContextMemory({
    userText: "继续检查 session.idle 串会话问题",
    sessionSummary: summary,
    project: { id: "p-long", name: "lily-workbench", path: "/repo/lily" },
    learnedConventions: "- 运行时问题先检查 OpenCode 原生能力",
    turnPolicy: { rigor: "coverage", memoryBudget: { maxChars: 900, criticalMaxChars: 700 } },
  });
  assert.equal(memory.items.some((item) => item.kind === "evidence_gap"), true, "evidence gaps survive long sessions");
  assert.equal(memory.items.some((item) => item.kind === "learned_conventions"), true, "learned conventions survive long sessions");
  assert.equal(memory.items.some((item) => item.sourcePointers?.length), true, "memory remains auditable");

  markContextMemoryInjected("s-long", {
    fingerprint: memory.fingerprint,
    itemCount: memory.items.length,
    totalChars: memory.totalChars,
  });
  summary = readSessionSummary("s-long");
  const repeated = buildContextMemory({
    userText: "继续检查 session.idle 串会话问题",
    sessionSummary: summary,
    project: { id: "p-long", name: "lily-workbench", path: "/repo/lily" },
    learnedConventions: "- 运行时问题先检查 OpenCode 原生能力",
    turnPolicy: { rigor: "coverage", memoryBudget: { maxChars: 900, criticalMaxChars: 700 } },
  });
  assert.equal(repeated.fingerprint, memory.fingerprint, "same selected memory is stable before compaction");

  const decision = decideBackgroundCompaction({
    capabilities: { nativeCompaction: true },
    runner: { alive: true, busy: false },
    sessionSummary: summary,
    contextWindowTokens: 4_000,
    tokenPressureThreshold: 0.72,
  });
  assert.equal(decision.action, "compact", "long sessions compact while idle");

  markSessionCompacted("s-long", {
    runtime: "opencode",
    mode: "native",
    reason: decision.reason,
    engineSessionId: "ses_long",
    summaryMessageId: "msg_summary_long",
  });
  summary = readSessionSummary("s-long");
  assert.equal(summary.contextEpoch, 1, "compaction advances epoch");
  assert.equal(summary.lastContextMemoryFingerprint, "", "compaction clears stale memory fingerprint");
  assert.equal(summary.lastCompaction.summaryMessageId, "msg_summary_long");

  console.log("context-os-long-session: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
