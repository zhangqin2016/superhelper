"use strict";

const DEFAULT_MIN_TURNS_BEFORE_COMPACT = 24;
const DEFAULT_MIN_COMPACTION_INTERVAL_MS = 20 * 60 * 1000;
const DEFAULT_TOKEN_PRESSURE_THRESHOLD = 0.72;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 120_000;

function normalizeModelRef(model = {}) {
  const source = model && typeof model === "object" ? model : {};
  return {
    providerID: String(source.providerID || source.provider || "").trim(),
    modelID: String(source.modelID || source.model || "").trim(),
  };
}

function nativeCompactionUnsupportedReason(model = {}) {
  const { providerID, modelID } = normalizeModelRef(model);
  const provider = providerID.toLowerCase();
  const modelName = modelID.toLowerCase();
  if (!provider || !modelName) return "";

  // Hard kill switch only. The previous blanket skip for "anthropic + non-Claude"
  // was a MISDIAGNOSIS: the captured 500 ("UnknownError / Unexpected server
  // error") came from OpenCode running its `compaction`/`title` agents on their
  // unpinned default model (`opencode/*-free`, no credentials in our build) —
  // NOT from the gateway rejecting summarize. With those agents now pinned to the
  // distributed model (opencode-config-builder MODEL_PINNED_AGENTS), summarize
  // runs on the working gateway. So native compaction is re-enabled; if a real
  // failure recurs it self-limits via decideBackgroundCompaction's per-session
  // failure backoff, and Lily's rolling memory stays as the fallback. Force-off
  // with LILY_OPENCODE_DISABLE_NATIVE_COMPACTION=1 if a gateway genuinely 500s.
  if (/^(1|true|yes|on)$/i.test(String(process.env.LILY_OPENCODE_DISABLE_NATIVE_COMPACTION || ""))) {
    return "disabled_by_env";
  }
  return "";
}

function runtimeSupportsNativeCompaction(capabilities = {}, model = {}) {
  if (!Boolean(capabilities.nativeCompaction || capabilities.manualSummarize)) return false;
  return !nativeCompactionUnsupportedReason(model);
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
  model = {},
  runner = {},
  sessionSummary = {},
  now = Date.now(),
  minTurnsBeforeCompact = DEFAULT_MIN_TURNS_BEFORE_COMPACT,
  minIntervalMs = DEFAULT_MIN_COMPACTION_INTERVAL_MS,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  tokenPressureThreshold = DEFAULT_TOKEN_PRESSURE_THRESHOLD,
} = {}) {
  if (!Boolean(capabilities.nativeCompaction || capabilities.manualSummarize)) {
    return { action: "skip", reason: "unsupported_runtime" };
  }
  const unsupportedModelReason = nativeCompactionUnsupportedReason(model);
  if (unsupportedModelReason) {
    const { providerID, modelID } = normalizeModelRef(model);
    return {
      action: "skip",
      reason: "unsupported_model_compaction",
      unsupportedReason: unsupportedModelReason,
      providerID,
      modelID,
    };
  }
  if (!runner.alive) return { action: "skip", reason: "runner_not_alive" };
  if (runner.busy) return { action: "skip", reason: "runner_busy" };

  const lastCompactedAt = parseTime(sessionSummary.lastCompactedAt);
  if (lastCompactedAt > 0 && now - lastCompactedAt < minIntervalMs) {
    return { action: "skip", reason: "recently_compacted" };
  }
  const lastCompactionFailedAt = parseTime(sessionSummary.lastCompactionFailedAt);
  if (lastCompactionFailedAt > 0 && now - lastCompactionFailedAt < minIntervalMs) {
    return {
      action: "skip",
      reason: "recent_compaction_failure",
      lastCompactionFailedAt: sessionSummary.lastCompactionFailedAt,
    };
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
  nativeCompactionUnsupportedReason,
  runtimeSupportsNativeCompaction,
};
