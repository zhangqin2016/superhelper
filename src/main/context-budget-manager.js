"use strict";

const DEFAULT_MIN_TURNS_BEFORE_COMPACT = 24;
const DEFAULT_MIN_COMPACTION_INTERVAL_MS = 20 * 60 * 1000;
const DEFAULT_TOKEN_PRESSURE_THRESHOLD = 0.72;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 120_000;

function runtimeSupportsNativeCompaction(capabilities = {}) {
  return Boolean(capabilities.nativeCompaction || capabilities.manualSummarize);
}

function parseTime(value) {
  if (!value) return 0;
  const n = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
}

function estimateTokensFromChars(chars) {
  const value = Number(chars || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 4);
}

function providerTokenRatio({ provider = "", model = "" } = {}) {
  const key = `${provider} ${model}`.toLowerCase();
  if (/\b(openai|gpt-|o[0-9])\b/.test(key)) return { latinCharsPerToken: 3.7, cjkCharsPerToken: 1.15 };
  if (/\b(anthropic|claude)\b/.test(key)) return { latinCharsPerToken: 3.9, cjkCharsPerToken: 1.2 };
  if (/\b(qwen|deepseek|glm|moonshot|kimi)\b/.test(key)) return { latinCharsPerToken: 3.6, cjkCharsPerToken: 1.05 };
  return { latinCharsPerToken: 3.8, cjkCharsPerToken: 1.1 };
}

function estimateTokensForText(text, opts = {}) {
  const source = String(text || "");
  if (!source) return { tokens: 0, source: "empty" };
  const compact = source.replace(/\s+/g, " ");
  const cjkChars = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const nonSpaceChars = compact.replace(/\s/g, "").length;
  const latinLikeChars = Math.max(0, nonSpaceChars - cjkChars);
  const punctuation = (compact.match(/[^\s\p{L}\p{N}]/gu) || []).length;
  const { latinCharsPerToken, cjkCharsPerToken } = providerTokenRatio(opts);
  const tokens = Math.ceil(
    latinLikeChars / latinCharsPerToken +
      cjkChars / cjkCharsPerToken +
      punctuation * 0.2,
  );
  return {
    tokens: Math.max(1, tokens),
    source: "estimated_provider_fallback",
    model: opts.model || "",
    provider: opts.provider || "",
  };
}

function decideBackgroundCompaction({
  capabilities = {},
  runner = {},
  sessionSummary = {},
  now = Date.now(),
  minTurnsBeforeCompact = DEFAULT_MIN_TURNS_BEFORE_COMPACT,
  minIntervalMs = DEFAULT_MIN_COMPACTION_INTERVAL_MS,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  tokenPressureThreshold = DEFAULT_TOKEN_PRESSURE_THRESHOLD,
} = {}) {
  if (!runtimeSupportsNativeCompaction(capabilities)) return { action: "skip", reason: "unsupported_runtime" };
  if (!runner.alive) return { action: "skip", reason: "runner_not_alive" };
  if (runner.busy) return { action: "skip", reason: "runner_busy" };

  const lastCompactedAt = parseTime(sessionSummary.lastCompactedAt);
  if (lastCompactedAt > 0 && now - lastCompactedAt < minIntervalMs) {
    return { action: "skip", reason: "recently_compacted" };
  }

  const estimatedPromptTokens = Number(sessionSummary.lastEnginePromptTokens || 0);
  const maxTokens = Number(contextWindowTokens || 0);
  const pressureThreshold = Number(tokenPressureThreshold || 0);
  if (
    Number.isFinite(estimatedPromptTokens) &&
    Number.isFinite(maxTokens) &&
    Number.isFinite(pressureThreshold) &&
    estimatedPromptTokens > 0 &&
    maxTokens > 0 &&
    pressureThreshold > 0 &&
    estimatedPromptTokens >= maxTokens * pressureThreshold
  ) {
    return {
      action: "compact",
      reason: "token_pressure",
      mode: "native",
      estimatedPromptTokens,
      contextWindowTokens: maxTokens,
      tokenSource: sessionSummary.lastEnginePromptTokenSource || "",
    };
  }

  const turnCount = Number(sessionSummary.turnCount || 0);
  if (!Number.isFinite(turnCount) || turnCount < minTurnsBeforeCompact) {
    return { action: "skip", reason: "below_threshold" };
  }

  return { action: "compact", reason: "long_session", mode: "native" };
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MIN_TURNS_BEFORE_COMPACT,
  DEFAULT_MIN_COMPACTION_INTERVAL_MS,
  DEFAULT_TOKEN_PRESSURE_THRESHOLD,
  decideBackgroundCompaction,
  estimateTokensForText,
  estimateTokensFromChars,
  runtimeSupportsNativeCompaction,
};
