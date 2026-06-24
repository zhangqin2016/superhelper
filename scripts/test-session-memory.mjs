#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-memory-"));
const electronPath = require.resolve("electron");

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: () => tempRoot,
    },
  },
};

const {
  clearSessionSummary,
  formatSessionSummary,
  markContextMemoryInjected,
  markSessionCompacted,
  readSessionSummary,
  updateSessionSummaryFromRecord,
} = require("../src/main/session-memory.js");

try {
  updateSessionSummaryFromRecord("s1", {
    turnId: "turn_1",
    engineMessageId: "msg_1",
    terminal: "turn.completed",
    user: { text: "帮我重写前三章" },
    assistantText: "已经完成第一章。",
    fileChanges: [{ fileName: "第1章.md" }],
    usage: { input_tokens: 321, output_tokens: 12 },
    meta: { engine: { promptChars: 1600, estimatedPromptTokens: 400 } },
  });

  let summary = readSessionSummary("s1");
  if (summary.lastUserIntent !== "帮我重写前三章" || summary.pendingTask) {
    throw new Error(`completed turn summary incorrect: ${JSON.stringify(summary)}`);
  }
  if (
    summary.lastTurnId !== "turn_1" ||
    summary.lastEngineMessageId !== "msg_1" ||
    summary.recentTurnPointers?.at(-1)?.turnId !== "turn_1"
  ) {
    throw new Error(`summary should retain lossless turn pointers: ${JSON.stringify(summary)}`);
  }
  if (summary.lastEnginePromptTokens !== 321 || summary.lastEnginePromptTokenSource !== "runtime_usage") {
    throw new Error(`runtime usage tokens should override char estimates: ${JSON.stringify(summary)}`);
  }
  if (!formatSessionSummary(summary).includes("第1章.md")) {
    throw new Error("formatted summary should include recent files");
  }

  updateSessionSummaryFromRecord("s1", {
    terminal: "turn.stalled",
    user: { text: "继续第二章" },
    assistantText: "正在继续。",
    fileChanges: [],
  });
  summary = readSessionSummary("s1");
  if (summary.pendingTask !== "继续第二章") {
    throw new Error(`stalled turn should record pending task: ${JSON.stringify(summary)}`);
  }

  updateSessionSummaryFromRecord("s1", {
    turnId: "turn_gap_1",
    terminal: "turn.completed",
    user: { text: "彻底找出所有 session.idle 问题" },
    assistantText: "已经找出全部 session.idle 问题。\n\n证据门槛：缺少候选集合。",
    fileChanges: [],
    meta: {
      evidenceGate: {
        ok: false,
        reason: "coverage_claim_without_candidate_set",
      },
    },
  });
  summary = readSessionSummary("s1");
  if (
    summary.lastEvidenceGap?.reason !== "coverage_claim_without_candidate_set" ||
    !summary.lastEvidenceGap?.userIntent?.includes("session.idle") ||
    !Array.isArray(summary.recentEvidenceGaps) ||
    summary.recentEvidenceGaps.length !== 1
  ) {
    throw new Error(`unsupported claims should be retained as evidence gaps: ${JSON.stringify(summary)}`);
  }
  if (!formatSessionSummary(summary).includes("coverage_claim_without_candidate_set")) {
    throw new Error("formatted summary should include recent evidence gaps");
  }

  const compacted = markSessionCompacted("s1", {
    runtime: "opencode",
    mode: "native",
    reason: "long_session",
    engineSessionId: "ses_1",
    summaryMessageId: "msg_summary",
    at: "2026-06-25T10:00:00.000Z",
  });
  if (
    compacted.lastCompactedAt !== "2026-06-25T10:00:00.000Z" ||
    compacted.compactionCount !== 1 ||
    compacted.lastCompaction?.runtime !== "opencode" ||
    compacted.lastCompaction?.engineSessionId !== "ses_1" ||
    compacted.lastCompaction?.summaryMessageId !== "msg_summary" ||
    compacted.contextEpoch !== 1
  ) {
    throw new Error(`compaction metadata should be persisted: ${JSON.stringify(compacted)}`);
  }
  summary = readSessionSummary("s1");
  if (summary.lastCompactedAt !== "2026-06-25T10:00:00.000Z") {
    throw new Error(`read summary should include compaction metadata: ${JSON.stringify(summary)}`);
  }

  const injected = markContextMemoryInjected("s1", {
    fingerprint: "a".repeat(64),
    itemCount: 3,
    totalChars: 1024,
    explanation: { selected: ["session_summary: test"], skipped: [] },
    at: "2026-06-25T11:00:00.000Z",
  });
  if (
    injected.lastContextMemoryFingerprint !== "a".repeat(64) ||
    injected.lastContextMemoryInjection?.itemCount !== 3 ||
    injected.lastContextMemoryInjection?.totalChars !== 1024 ||
    injected.lastContextMemoryInjection?.explanation?.selected?.[0] !== "session_summary: test" ||
    injected.lastContextMemoryInjection?.contextEpoch !== 1
  ) {
    throw new Error(`context memory injection metadata should be persisted: ${JSON.stringify(injected)}`);
  }

  const compactedAgain = markSessionCompacted("s1", {
    runtime: "opencode",
    mode: "native",
    reason: "manual",
    at: "2026-06-25T12:00:00.000Z",
  });
  if (
    compactedAgain.contextEpoch !== 2 ||
    compactedAgain.lastContextMemoryFingerprint ||
    compactedAgain.lastContextMemoryInjection
  ) {
    throw new Error(`compaction should advance epoch and clear stale injection fingerprints: ${JSON.stringify(compactedAgain)}`);
  }

  clearSessionSummary("s1");
  if (readSessionSummary("s1")) {
    throw new Error("clearSessionSummary should remove summary file");
  }

  console.log("session-memory: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
