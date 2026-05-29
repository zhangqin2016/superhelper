"use strict";

/**
 * Map app-facing env keys (LILY_*) to upstream engine variables at spawn time only.
 * Legacy ANTHROPIC_* / CLAUDE_CODE_* in settings.json are still read for migration.
 */

const LILY_TO_ENGINE = {
  LILY_API_BASE_URL: "ANTHROPIC_BASE_URL",
  LILY_API_KEY: "ANTHROPIC_AUTH_TOKEN",
  LILY_MODEL: "ANTHROPIC_MODEL",
  LILY_MODEL_OPUS: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  LILY_MODEL_SONNET: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  LILY_MODEL_HAIKU: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  LILY_SUBAGENT_MODEL: "CLAUDE_CODE_SUBAGENT_MODEL",
  LILY_EFFORT_LEVEL: "CLAUDE_CODE_EFFORT_LEVEL",
};

const LEGACY_TO_LILY = {
  ANTHROPIC_BASE_URL: "LILY_API_BASE_URL",
  ANTHROPIC_AUTH_TOKEN: "LILY_API_KEY",
  ANTHROPIC_API_KEY: "LILY_API_KEY",
  ANTHROPIC_MODEL: "LILY_MODEL",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "LILY_MODEL_OPUS",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "LILY_MODEL_SONNET",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "LILY_MODEL_HAIKU",
  CLAUDE_CODE_SUBAGENT_MODEL: "LILY_SUBAGENT_MODEL",
  CLAUDE_CODE_EFFORT_LEVEL: "LILY_EFFORT_LEVEL",
};

/** Keys passed through unchanged (vision, dashscope, timeouts, etc.). */
const PASSTHROUGH_PREFIXES = ["VISION_", "DASHSCOPE_", "API_TIMEOUT"];

function isPassthroughKey(key) {
  return PASSTHROUGH_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Normalize settings/catalog env to LILY_* keys (in-memory; does not rewrite files).
 * @param {Record<string, string>} raw
 */
function normalizeToLilyEnv(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [key, value] of Object.entries(raw)) {
    if (value == null || value === "") continue;
    if (key.startsWith("LILY_") || isPassthroughKey(key)) {
      out[key] = String(value);
      continue;
    }
    const lilyKey = LEGACY_TO_LILY[key];
    if (lilyKey) {
      if (!(lilyKey in out)) out[lilyKey] = String(value);
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

/**
 * Build process env for spawning the upstream engine binary.
 * @param {Record<string, string>} lilyEnv
 */
function toEngineEnv(lilyEnv) {
  const engine = {};
  for (const [lilyKey, engineKey] of Object.entries(LILY_TO_ENGINE)) {
    if (lilyEnv[lilyKey] != null && lilyEnv[lilyKey] !== "") {
      engine[engineKey] = lilyEnv[lilyKey];
    }
  }
  for (const [key, value] of Object.entries(lilyEnv)) {
    if (key.startsWith("LILY_") || key in LEGACY_TO_LILY) continue;
    if (isPassthroughKey(key)) engine[key] = value;
  }
  return engine;
}

function pickModelId(lilyEnv) {
  return lilyEnv.LILY_MODEL || "";
}

module.exports = {
  LILY_TO_ENGINE,
  LEGACY_TO_LILY,
  normalizeToLilyEnv,
  toEngineEnv,
  pickModelId,
};
