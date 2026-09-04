"use strict";

const { normalizeToLilyEnv } = require("./agent-env");

function buildCustomPresetEnv(entry, presetEnv = {}, buildCompatibilityEnv = () => ({})) {
  const env = { ...normalizeToLilyEnv(presetEnv || {}) };
  const baseUrl = String(entry?.baseUrl || "").trim();
  const apiKey = String(entry?.apiKey || "").trim();
  const protocol = entry?.protocol === "anthropic" || entry?.protocol === "openai"
    ? entry.protocol : (/\/anthropic(\/|$)/i.test(baseUrl) ? "anthropic" : "openai");
  if (baseUrl) env.LILY_API_BASE_URL = baseUrl;
  if (apiKey) env.LILY_API_KEY = apiKey;
  if (protocol) env.LILY_OPENCODE_PROTOCOL = protocol;
  if (entry?.tlsSkipVerify && baseUrl) env.LILY_TLS_SKIP_VERIFY = "1";
  Object.assign(env, buildCompatibilityEnv(entry?.compatibilityProfile, entry?.requestBodyOverlay));
  return env;
}

module.exports = { buildCustomPresetEnv };
