#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  decideBackgroundCompaction,
  estimateTokensForText,
  estimateTokensFromChars,
  runtimeSupportsNativeCompaction,
} = require("../src/main/context-budget-manager.js");

assert.equal(runtimeSupportsNativeCompaction({ nativeCompaction: true }), true);
assert.equal(runtimeSupportsNativeCompaction({ nativeCompaction: false, manualSummarize: true }), true);
assert.equal(runtimeSupportsNativeCompaction({}), false);
assert.equal(estimateTokensFromChars(0), 0);
assert.equal(estimateTokensFromChars(17), 5);
assert.equal(estimateTokensForText("").tokens, 0);
assert.equal(estimateTokensForText("hello world", { provider: "openai", model: "gpt-5" }).source, "estimated_provider_fallback");
assert.equal(
  estimateTokensForText("这是一个中文长问题，需要分析上下文压缩和记忆", { provider: "qwen" }).tokens >
    estimateTokensFromChars("这是一个中文长问题，需要分析上下文压缩和记忆".length),
  true,
  "provider fallback avoids undercounting CJK-heavy prompts",
);

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 8 },
    now: 1_000_000,
  }),
  { action: "skip", reason: "below_threshold" },
  "ordinary short sessions stay fast",
);

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    runner: { alive: true, busy: true },
    sessionSummary: { turnCount: 40 },
    now: 1_000_000,
  }),
  { action: "skip", reason: "runner_busy" },
  "background compaction never interrupts an active turn",
);

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 40, lastCompactedAt: new Date(950_000).toISOString() },
    now: 1_000_000,
  }),
  { action: "skip", reason: "recently_compacted" },
  "recent compaction is rate-limited",
);

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 2, lastEnginePromptTokens: 90, lastEnginePromptTokenSource: "runtime_usage" },
    now: 1_000_000,
    contextWindowTokens: 100,
    tokenPressureThreshold: 0.72,
  }),
  {
    action: "compact",
    reason: "token_pressure",
    mode: "native",
    estimatedPromptTokens: 90,
    contextWindowTokens: 100,
    tokenSource: "runtime_usage",
  },
  "large assembled prompts can compact before turn-count threshold",
);

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 40 },
    now: 1_000_000,
  }),
  { action: "compact", reason: "long_session", mode: "native" },
  "long idle sessions use native runtime compaction",
);

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: false, manualSummarize: false },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 40 },
    now: 1_000_000,
  }),
  { action: "skip", reason: "unsupported_runtime" },
  "runtime capabilities gate background compaction",
);

console.log("context-budget-manager: ok");
