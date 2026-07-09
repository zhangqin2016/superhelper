"use strict";

const { classifyModelRoute } = require("../model-route-audit");

/**
 * Translate Lily's distributed model config (resolved LILY_* env — endpoint,
 * token, model id) into the OpenCode provider config + model Ref.
 *
 * Lily may receive an Anthropic-compatible endpoint (e.g. DeepSeek's
 * https://api.deepseek.com/anthropic) or an OpenAI-compatible endpoint. The
 * service/client config should now pass explicit LILY_OPENCODE_PROTOCOL plus an
 * allowlisted OpenCode provider id/npm. URL-based protocol detection remains only
 * as a legacy fallback for old saved custom configs.
 *
 * Emitted as OPENCODE_CONFIG_CONTENT (V1 config schema). options is StructWithRest
 * so we pass apiKey (-> x-api-key for anthropic / Bearer for openai-compatible)
 * AND an explicit Authorization: Bearer header — covering whichever the gateway
 * wants.
 */

/** Trim trailing slash. */
function trimUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}
/** Anthropic SDK appends `/messages`; Claude hits `<base>/v1/messages`. Ensure /v1. */
function anthropicUrl(base) {
  const t = trimUrl(base);
  if (!t) return "";
  return /\/v\d+$/.test(t) ? t : `${t}/v1`;
}
/** OpenAI-compatible SDK appends `/chat/completions`; use the base verbatim. */
function openaiUrl(base) {
  return trimUrl(base);
}

const OPENCODE_PROVIDER_DEFAULTS = Object.freeze({
  anthropic: { providerID: "anthropic", npm: "@ai-sdk/anthropic" },
  openai: { providerID: "lily", npm: "@ai-sdk/openai-compatible" },
});

function normalizeProtocol(value) {
  const protocol = String(value || "").toLowerCase();
  return protocol === "anthropic" || protocol === "openai" ? protocol : "";
}

function legacyProtocolForBaseUrl(baseUrl) {
  return /\/anthropic(\/|$)/i.test(baseUrl) ? "anthropic" : "openai";
}

function detectProtocol(baseUrl, env = {}) {
  const override = normalizeProtocol(env.LILY_OPENCODE_PROTOCOL);
  if (override) return override;
  return legacyProtocolForBaseUrl(baseUrl);
}

function providerNpmProtocol(npm) {
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  if (npm === "@ai-sdk/openai-compatible") return "openai";
  return "";
}

function normalizeProviderId(value, protocol) {
  const fallback = OPENCODE_PROVIDER_DEFAULTS[protocol]?.providerID || OPENCODE_PROVIDER_DEFAULTS.openai.providerID;
  const providerID = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(providerID) ? providerID : fallback;
}

function resolveOpencodeProviderSpec(env = {}, protocol = "openai") {
  const defaults = OPENCODE_PROVIDER_DEFAULTS[protocol] || OPENCODE_PROVIDER_DEFAULTS.openai;
  const requestedNpm = String(env.LILY_OPENCODE_PROVIDER_NPM || "").trim();
  const requestedNpmProtocol = providerNpmProtocol(requestedNpm);
  const npm = requestedNpmProtocol === protocol ? requestedNpm : defaults.npm;
  return {
    providerID: normalizeProviderId(env.LILY_OPENCODE_PROVIDER_ID, protocol),
    npm,
  };
}

function forceProModelId(id, protocol = "anthropic") {
  const model = String(id || "").trim();
  const isOpenAi = String(protocol || "").toLowerCase() === "openai";
  if (isOpenAi && /^deepseek-v4-pro\[[^\]]+\]$/i.test(model)) return "deepseek-v4-pro";
  if (/^deepseek-v4-flash$/i.test(model)) return isOpenAi ? "deepseek-v4-pro" : "deepseek-v4-pro[1m]";
  return model;
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function parseBodyOverlay(value) {
  const text = String(value || "").trim();
  if (!text) return { ok: true, body: null };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "LILY_OPENCODE_BODY_OVERLAY_JSON must be a JSON object" };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, error: "LILY_OPENCODE_BODY_OVERLAY_JSON is not valid JSON" };
  }
}

/**
 * @param {Record<string, string>} lilyEnv
 * @returns {{ ok:boolean, reason?:string, model:{providerID:string,modelID:string}|null,
 *             tiers:object|null, configContent:string|null, baseUrl:string, protocol?:string }}
 */
function resolveOpencodeModelConfig(lilyEnv = {}) {
  const rawBase = lilyEnv.LILY_OPENCODE_BASE_URL || lilyEnv.LILY_API_BASE_URL || "";
  const token = lilyEnv.LILY_OPENCODE_API_KEY || lilyEnv.LILY_API_KEY || "";
  const requestedModelId = lilyEnv.LILY_OPENCODE_MODEL || lilyEnv.LILY_MODEL || "";
  const protocol = detectProtocol(rawBase, lilyEnv);
  const modelId = forceProModelId(requestedModelId, protocol);
  const modelRoute = classifyModelRoute(lilyEnv);
  const bodyOverlay = parseBodyOverlay(lilyEnv.LILY_OPENCODE_BODY_OVERLAY_JSON);

  if (!modelId) {
    return {
      ok: false,
      reason: "no model selected (LILY_MODEL missing)",
      model: null,
      tiers: null,
      configContent: null,
      baseUrl: "",
      diagnostics: { modelRoute },
    };
  }
  if (!bodyOverlay.ok) {
    return {
      ok: false,
      reason: bodyOverlay.error,
      model: null,
      tiers: null,
      configContent: null,
      baseUrl: rawBase,
      diagnostics: { modelRoute },
    };
  }
  if (rawBase && rawBase.trim().startsWith("/")) {
    return {
      ok: false,
      reason: `gateway base URL is a relative managed path (${rawBase}); Lily runtime needs an absolute URL`,
      model: null,
      tiers: null,
      configContent: null,
      baseUrl: rawBase,
      diagnostics: { modelRoute },
    };
  }

  const providerSpec = resolveOpencodeProviderSpec(lilyEnv, protocol);
  const providerID = providerSpec.providerID;
  const npm = providerSpec.npm;
  const baseURL = protocol === "anthropic" ? anthropicUrl(rawBase) : openaiUrl(rawBase);

  // Keep every OpenCode tier on the selected Pro model. Fast/haiku/subagent
  // tiers make the app feel inconsistent because OpenCode can route Task tools,
  // titles, and summaries through them even when the user selected Pro.
  const tiers = {
    main: modelId,
    opus: modelId,
    sonnet: modelId,
    haiku: modelId,
    subagent: modelId,
  };
  const modelOptions = bodyOverlay.body && protocol === "openai" ? { ...bodyOverlay.body } : null;
  const models = {};
  for (const id of [tiers.main, tiers.opus, tiers.sonnet, tiers.haiku, tiers.subagent]) {
    if (id) models[id] = models[id] || (modelOptions ? { options: modelOptions } : {});
  }

  const options = {};
  if (baseURL) options.baseURL = baseURL;
  // Some OpenAI-compatible/self-hosted servers (notably vLLM deployments) emit
  // a stream usage-only chunk without `choices`. OpenCode defaults
  // includeUsage=true for @ai-sdk/openai-compatible, and the AI SDK rejects that
  // non-standard chunk before the completed assistant text can settle. Disabling
  // streaming usage keeps the model URL/body otherwise unchanged.
  if (protocol === "openai") options.includeUsage = false;
  if (token) {
    options.apiKey = token;
    options.headers = { Authorization: `Bearer ${token}` };
  }

  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${providerID}/${modelId}`,
    provider: {
      [providerID]: { npm, name: "Lily", options, models },
    },
  };

  return {
    ok: true,
    model: {
      providerID,
      modelID: modelId,
      contextWindowTokens: positiveInt(lilyEnv.LILY_CONTEXT_WINDOW_TOKENS),
      maxOutputTokens: positiveInt(lilyEnv.LILY_MAX_OUTPUT_TOKENS),
    },
    tiers,
    diagnostics: {
      modelRoute,
      subagentModel: tiers.subagent,
      subagentModelSource: "LILY_MODEL_FORCED_MAIN",
      subagentUsesMainModel: true,
      requestedModel: requestedModelId,
      forcedModel: requestedModelId !== modelId ? modelId : "",
      opencodeProviderID: providerID,
      opencodeProviderNpm: npm,
      forcedMainModelForAllTiers: true,
      ignoredTierModels: {
        opus: lilyEnv.LILY_MODEL_OPUS || "",
        sonnet: lilyEnv.LILY_MODEL_SONNET || "",
        haiku: lilyEnv.LILY_MODEL_HAIKU || "",
        subagent: lilyEnv.LILY_SUBAGENT_MODEL || "",
      },
    },
    configContent: JSON.stringify(config),
    baseUrl: baseURL,
    protocol,
  };
}

module.exports = {
  resolveOpencodeModelConfig,
  detectProtocol,
  anthropicUrl,
  openaiUrl,
  forceProModelId,
  resolveOpencodeProviderSpec,
  parseBodyOverlay,
};
