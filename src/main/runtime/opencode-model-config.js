"use strict";

const { classifyModelRoute } = require("../model-route-audit");

/**
 * Translate Lily's distributed model config (resolved LILY_* env — endpoint,
 * token, model id) into the OpenCode provider config + model Ref.
 *
 * Lily may receive an Anthropic-compatible endpoint (e.g. DeepSeek's
 * https://api.deepseek.com/anthropic) or an OpenAI-compatible endpoint. OpenCode
 * can speak either protocol, so we AUTO-DETECT from the endpoint and pick the
 * matching AI-SDK provider:
 *   - "/anthropic" endpoint  -> @ai-sdk/anthropic       (provider id "anthropic")
 *   - anything else          -> @ai-sdk/openai-compatible (provider id "lily")
 * Override with LILY_OPENCODE_PROTOCOL=anthropic|openai if ever needed.
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

function detectProtocol(baseUrl, env = {}) {
  const override = String(env.LILY_OPENCODE_PROTOCOL || "").toLowerCase();
  if (override === "anthropic" || override === "openai") return override;
  return /\/anthropic(\/|$)/i.test(baseUrl) ? "anthropic" : "openai";
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

  const providerID = protocol === "anthropic" ? "anthropic" : "lily";
  const npm = protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
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
  const models = {};
  for (const id of [tiers.main, tiers.opus, tiers.sonnet, tiers.haiku, tiers.subagent]) {
    if (id) models[id] = models[id] || {};
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

module.exports = { resolveOpencodeModelConfig, detectProtocol, anthropicUrl, openaiUrl, forceProModelId };
