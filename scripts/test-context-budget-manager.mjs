#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  decideBackgroundCompaction,
  decidePreTurnCompaction,
  estimateTokensForText,
  estimateTokensFromChars,
  nativeCompactionUnsupportedReason,
  resolveContextBudget,
  runtimeSupportsNativeCompaction,
} = require("../src/main/context-budget-manager.js");

assert.equal(runtimeSupportsNativeCompaction({ nativeCompaction: true }), true);
assert.equal(runtimeSupportsNativeCompaction({ nativeCompaction: false, manualSummarize: true }), true);
// WHY: native compaction is the long-session memory. It used to be force-disabled
// for our anthropic-compatible DeepSeek model on the theory that the gateway 500s
// on summarize. The real cause was OpenCode running compaction on its unpinned
// default model (opencode/*-free, no creds); with that agent now pinned to the
// distributed model, summarize works — so this model IS supported again.
assert.equal(
  runtimeSupportsNativeCompaction(
    { nativeCompaction: true, manualSummarize: true },
    { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" },
  ),
  true,
);
assert.equal(
  nativeCompactionUnsupportedReason({ providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" }),
  "",
  "anthropic-compatible non-Claude models are supported once the compaction agent is model-pinned",
);
assert.equal(
  nativeCompactionUnsupportedReason({ providerID: "anthropic", modelID: "claude-sonnet-4" }),
  "",
);
// Operator kill switch: if a gateway genuinely rejects summarize, force-disable
// without a rebuild and fall back to Lily's rolling memory.
process.env.LILY_OPENCODE_DISABLE_NATIVE_COMPACTION = "1";
assert.equal(
  nativeCompactionUnsupportedReason({ providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" }),
  "disabled_by_env",
  "env kill switch force-disables native compaction",
);
delete process.env.LILY_OPENCODE_DISABLE_NATIVE_COMPACTION;
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

{
  const small = resolveContextBudget({
    model: { providerID: "lily", modelID: "self-hosted", contextWindowTokens: 65_536 },
    tokenSource: "estimated_provider_fallback",
  });
  const large = resolveContextBudget({
    model: { providerID: "anthropic", modelID: "large-context", contextWindowTokens: 1_000_000 },
    tokenSource: "runtime_usage",
  });
  const largeWithHugeOutput = resolveContextBudget({
    model: {
      providerID: "openai",
      modelID: "large-output-context",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
    },
    tokenSource: "runtime_usage",
  });
  assert.equal(small.contextWindowTokens, 65_536, "budget uses model capability, not a hard-coded provider name");
  assert(small.compactionTriggerTokens < 55_000, "small windows keep a conservative trigger");
  assert(large.compactionTriggerTokens > 800_000, "large-context models keep their useful context instead of inheriting a 65k-style cap");
  assert.equal(large.budgetSource, "model_capability", "large budget is capability-derived");
  assert(largeWithHugeOutput.compactionTriggerTokens > 800_000, "huge max-output capability does not silently consume most input context");
}

assert.deepEqual(
  decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    model: { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 40 },
    now: 1_000_000,
  }),
  { action: "compact", reason: "long_session", mode: "native" },
  "long sessions on the distributed DeepSeek model now compact natively (no longer force-skipped)",
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
    sessionSummary: { turnCount: 40, lastCompactionFailedAt: new Date(950_000).toISOString() },
    now: 1_000_000,
  }),
  {
    action: "skip",
    reason: "recent_compaction_failure",
    lastCompactionFailedAt: new Date(950_000).toISOString(),
  },
  "failed native compaction is rate-limited instead of retried every turn",
);

{
  const decision = decideBackgroundCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    runner: { alive: true, busy: false },
    sessionSummary: {
      turnCount: 2,
      retainedContextTokens: 90,
      retainedContextTokenSource: "runtime_usage",
      lastEnginePromptTokens: 20,
      lastEnginePromptTokenSource: "estimated_provider_fallback",
    },
    now: 1_000_000,
    contextWindowTokens: 100,
    tokenPressureThreshold: 0.72,
  });
  assert.equal(decision.action, "compact", "large assembled prompts can compact before turn-count threshold");
  assert.equal(decision.reason, "token_pressure");
  assert.equal(decision.estimatedPromptTokens, 90);
  assert.equal(decision.contextWindowTokens, 100);
  assert.equal(decision.tokenSource, "runtime_usage");
  assert(decision.compactionTriggerTokens > 0, "decision exposes capability-derived trigger diagnostics");
}

{
  const qwenPressure = decidePreTurnCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    model: { providerID: "lily", modelID: "/private/Qwen3-Coder-Next", contextWindowTokens: 65_536 },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 3, lastEnginePromptTokens: 49_000 },
    currentPromptTokens: 2_000,
    now: 1_000_000,
  });
  assert.equal(qwenPressure.action, "compact", "pre-turn token pressure compacts self-hosted small windows before sending");
  assert.equal(qwenPressure.reason, "pre_turn_token_pressure");

  const coldStartPressure = decidePreTurnCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    model: { providerID: "lily", modelID: "/private/Qwen3-Coder-Next", contextWindowTokens: 65_536 },
    runner: { alive: false, canStart: true, busy: false },
    sessionSummary: { turnCount: 3, lastEnginePromptTokens: 49_000 },
    currentPromptTokens: 2_000,
    now: 1_000_000,
  });
  assert.equal(coldStartPressure.action, "compact", "pre-turn compaction may start an idle runtime before sending");

  const nextTurnPressure = decidePreTurnCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    model: { providerID: "lily", modelID: "100k-window", contextWindowTokens: 100_000 },
    runner: { alive: true, busy: false },
    sessionSummary: {
      turnCount: 3,
      retainedContextTokens: 60_000,
      retainedContextTokenSource: "estimated_retained_context",
      lastEnginePromptTokens: 20_000,
    },
    currentPromptTokens: 20_000,
    now: 1_000_000,
  });
  assert.equal(nextTurnPressure.estimatedPromptTokens, 80_000,
    "next-turn pressure includes both retained history and current input");
  assert.equal(nextTurnPressure.action, "compact",
    "combined 80k pressure compacts before sending into a 100k window");

  const topModelRoom = decidePreTurnCompaction({
    capabilities: { nativeCompaction: true, manualSummarize: true },
    model: { providerID: "anthropic", modelID: "claude-large", contextWindowTokens: 1_000_000 },
    runner: { alive: true, busy: false },
    sessionSummary: { turnCount: 3, lastEnginePromptTokens: 120_000 },
    currentPromptTokens: 10_000,
    now: 1_000_000,
  });
  assert.equal(topModelRoom.action, "skip", "large-context models are not made dumber by small-window pressure");
  assert.equal(topModelRoom.reason, "below_token_pressure");

  const fallback = decidePreTurnCompaction({
    capabilities: { nativeCompaction: false, manualSummarize: false },
    model: { contextWindowTokens: 65_536 },
    runner: { alive: true, busy: false },
    sessionSummary: { lastEnginePromptTokens: 60_000 },
    currentPromptTokens: 60_000,
  });
  assert.deepEqual(fallback, { action: "skip", reason: "unsupported_runtime" }, "missing compaction capability fails open to current behavior");
}

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
