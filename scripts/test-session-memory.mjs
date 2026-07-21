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
  markSessionCompactionFailed,
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
  if (summary.retainedContextTokens !== 333 || summary.retainedContextTokenSource !== "runtime_usage") {
    throw new Error(`runtime input + output should become the authoritative retained context: ${JSON.stringify(summary)}`);
  }
  if (!formatSessionSummary(summary).includes("第1章.md")) {
    throw new Error("formatted summary should include recent files");
  }

  updateSessionSummaryFromRecord("s_intent", {
    turnId: "turn_intent_1",
    terminal: "turn.completed",
    user: { text: "修复登录代码" },
    assistantText: "完成。",
    meta: {
      taskContract: {
        intentContract: {
          taskType: "code_change",
          objective: "修复登录代码",
          currentInstruction: "修复登录代码",
          deliverables: ["requested_workspace_change"],
          successCriteria: ["focused_test"],
        },
      },
    },
  });
  let intentSummary = readSessionSummary("s_intent");
  if (intentSummary.lastIntentContract?.taskType !== "code_change") {
    throw new Error(`session summary should retain the latest durable intent contract: ${JSON.stringify(intentSummary)}`);
  }
  updateSessionSummaryFromRecord("s_intent", {
    turnId: "turn_intent_2",
    terminal: "turn.completed",
    user: { text: "你好" },
    assistantText: "你好。",
    meta: {},
  });
  intentSummary = readSessionSummary("s_intent");
  if (intentSummary.lastIntentContract !== null) {
    throw new Error(`a later non-task turn must clear stale intent inheritance: ${JSON.stringify(intentSummary)}`);
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

  // Learning loop (2026-07-20 model-first): advisory-only findings (gate ok
  // but with telemetry reasons) also land in evidence-gap memory so the next
  // turn's model sees them — without any user-facing decoration.
  updateSessionSummaryFromRecord("s1", {
    turnId: "turn_gap_2",
    terminal: "turn.completed",
    user: { text: "彻底找出所有 session.idle 问题" },
    assistantText: "已经找出全部 session.idle 问题。",
    fileChanges: [],
    meta: {
      evidenceGate: {
        ok: true,
        advisoryReasons: ["coverage_claim_without_full_inspection"],
      },
    },
  });
  summary = readSessionSummary("s1");
  if (
    summary.lastEvidenceGap?.reason !== "coverage_claim_without_full_inspection" ||
    summary.recentEvidenceGaps.length !== 2
  ) {
    throw new Error(`advisory findings should also be retained as evidence gaps: ${JSON.stringify(summary)}`);
  }
  // A clean pass adds no gap.
  updateSessionSummaryFromRecord("s1", {
    turnId: "turn_clean_1",
    terminal: "turn.completed",
    user: { text: "hello" },
    assistantText: "hi",
    fileChanges: [],
    meta: { evidenceGate: { ok: true } },
  });
  summary = readSessionSummary("s1");
  if (summary.recentEvidenceGaps.length !== 2) {
    throw new Error(`a clean pass must not add evidence gaps: ${JSON.stringify(summary)}`);
  }

  // Fallback accounting is cumulative because per-turn prompt estimates only
  // describe the new turn payload. Output is retained too. Runtime usage later
  // replaces (rather than adds to) the estimate because its input already
  // includes prior context.
  updateSessionSummaryFromRecord("s_retained", {
    turnId: "retained_1",
    terminal: "turn.completed",
    user: { text: "first" },
    assistantText: "first result",
    meta: { engine: {
      estimatedPromptTokens: 100,
      estimatedPromptTokenSource: "estimated_provider_fallback",
      estimatedOutputTokens: 25,
      estimatedOutputTokenSource: "estimated_provider_fallback",
    } },
  });
  let retained = readSessionSummary("s_retained");
  if (retained.retainedContextTokens !== 125) {
    throw new Error(`first fallback turn should retain prompt + output: ${JSON.stringify(retained)}`);
  }
  updateSessionSummaryFromRecord("s_retained", {
    turnId: "retained_2",
    terminal: "turn.completed",
    user: { text: "second" },
    assistantText: "second result",
    meta: { engine: {
      estimatedPromptTokens: 50,
      estimatedPromptTokenSource: "estimated_provider_fallback",
      estimatedOutputTokens: 10,
      estimatedOutputTokenSource: "estimated_provider_fallback",
    } },
  });
  retained = readSessionSummary("s_retained");
  if (retained.retainedContextTokens !== 185 || retained.retainedContextTokenSource !== "estimated_retained_context") {
    throw new Error(`fallback turns should accumulate without losing prior context: ${JSON.stringify(retained)}`);
  }
  updateSessionSummaryFromRecord("s_retained", {
    turnId: "retained_3",
    terminal: "turn.completed",
    user: { text: "third" },
    assistantText: "third result",
    usage: { input_tokens: 160, output_tokens: 20 },
    meta: { engine: {
      estimatedPromptTokens: 50,
      estimatedPromptTokenSource: "estimated_provider_fallback",
      estimatedOutputTokens: 10,
      estimatedOutputTokenSource: "estimated_provider_fallback",
    } },
  });
  retained = readSessionSummary("s_retained");
  if (retained.retainedContextTokens !== 180 || retained.retainedContextTokenSource !== "runtime_usage") {
    throw new Error(`authoritative runtime usage must replace, not double-count, fallback history: ${JSON.stringify(retained)}`);
  }
  updateSessionSummaryFromRecord("s_input_only", {
    turnId: "input_only_1",
    terminal: "turn.completed",
    user: { text: "input usage only" },
    assistantText: "estimated result",
    usage: { input_tokens: 100 },
    meta: { engine: {
      estimatedPromptTokens: 90,
      estimatedPromptTokenSource: "estimated_provider_fallback",
      estimatedOutputTokens: 25,
      estimatedOutputTokenSource: "estimated_provider_fallback",
    } },
  });
  const inputOnly = readSessionSummary("s_input_only");
  if (
    inputOnly.retainedContextTokens !== 125 ||
    inputOnly.retainedContextTokenSource !== "runtime_usage_plus_estimated_output"
  ) {
    throw new Error(`input-only runtime usage must keep the best output delta: ${JSON.stringify(inputOnly)}`);
  }
  updateSessionSummaryFromRecord("s_output_without_tool", {
    terminal: "turn.completed",
    user: { text: "run" },
    assistantText: "done",
    meta: { engine: { estimatedPromptTokens: 40 } },
  });
  updateSessionSummaryFromRecord("s_output_with_tool", {
    terminal: "turn.completed",
    user: { text: "run" },
    assistantText: "done",
    tools: [{ name: "read", result: { output: "tool evidence ".repeat(80) } }],
    meta: { engine: { estimatedPromptTokens: 40 } },
  });
  const withoutToolOutput = readSessionSummary("s_output_without_tool");
  const withToolOutput = readSessionSummary("s_output_with_tool");
  if (!(withToolOutput.retainedContextTokens > withoutToolOutput.retainedContextTokens)) {
    throw new Error(`fallback accounting must retain tool output too: ${JSON.stringify({ withoutToolOutput, withToolOutput })}`);
  }
  const retainedCompacted = markSessionCompacted("s_retained", {
    runtime: "opencode",
    mode: "native",
    reason: "token_pressure",
  });
  if (
    retainedCompacted.retainedContextTokens !== 0 ||
    retainedCompacted.lastEnginePromptTokens !== 0 ||
    retainedCompacted.retainedContextTokenSource !== "compacted_reset"
  ) {
    throw new Error(`compaction must clear stale retained-pressure estimates: ${JSON.stringify(retainedCompacted)}`);
  }
  updateSessionSummaryFromRecord("s_retained", {
    turnId: "retained_4",
    terminal: "turn.completed",
    user: { text: "after compact" },
    assistantText: "new result",
    meta: { engine: {
      estimatedPromptTokens: 30,
      estimatedPromptTokenSource: "estimated_provider_fallback",
      estimatedOutputTokens: 5,
      estimatedOutputTokenSource: "estimated_provider_fallback",
    } },
  });
  retained = readSessionSummary("s_retained");
  if (retained.retainedContextTokens !== 35) {
    throw new Error(`post-compaction fallback must start a fresh estimate epoch: ${JSON.stringify(retained)}`);
  }

  updateSessionSummaryFromRecord("s1", {
    turnId: "turn_bad_tool_xml",
    terminal: "turn.completed",
    user: { text: "make four images" },
    assistantText: "> <parameter=timeout> 10000 </parameter> </function> </tool_call>",
    fileChanges: [],
  });
  summary = readSessionSummary("s1");
  if (summary.lastAssistantResult.includes("parameter=timeout") || formatSessionSummary(summary).includes("parameter=timeout")) {
    throw new Error(`tool-call fragments must not be stored as assistant memory: ${JSON.stringify(summary)}`);
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

  const failed = markSessionCompactionFailed("s1", {
    runtime: "opencode",
    mode: "native",
    reason: "token_pressure",
    providerID: "deepseek",
    modelID: "deepseek-chat",
    code: "UnknownError",
    error: "Unexpected server error",
    at: "2026-06-25T10:30:00.000Z",
  });
  if (
    failed.lastCompactionFailedAt !== "2026-06-25T10:30:00.000Z" ||
    failed.compactionFailureCount !== 1 ||
    failed.lastCompactionFailure?.providerID !== "deepseek" ||
    failed.lastCompactionFailure?.code !== "UnknownError"
  ) {
    throw new Error(`failed compaction metadata should be persisted: ${JSON.stringify(failed)}`);
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
    compactedAgain.lastContextMemoryInjection ||
    compactedAgain.lastCompactionFailedAt ||
    compactedAgain.lastCompactionFailure
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
