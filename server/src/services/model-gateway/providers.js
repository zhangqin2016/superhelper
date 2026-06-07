import { config } from "../../config.js";
import { cleanBaseUrl, parseJsonEnv } from "./utils.js";

function normalizeProvider(id, provider) {
  if (!provider || typeof provider !== "object") return null;
  return {
    id,
    type: String(provider.type || "openai").toLowerCase(),
    baseUrl: cleanBaseUrl(provider.baseUrl),
    apiKey: String(provider.apiKey || ""),
    model: String(provider.model || ""),
    models: Array.isArray(provider.models) ? provider.models.map(String).filter(Boolean) : [],
    headers: provider.headers && typeof provider.headers === "object" ? provider.headers : {},
  };
}

export function listModelGatewayProviders() {
  const providers = parseJsonEnv(config.modelGatewayProviders, {});
  const normalized = {};
  for (const [id, provider] of Object.entries(providers)) {
    const value = normalizeProvider(id, provider);
    if (value) normalized[id] = value;
  }

  if (config.anthropicApiKey && !normalized.anthropic) {
    normalized.anthropic = {
      id: "anthropic",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.anthropicBaseUrl),
      apiKey: config.anthropicApiKey,
      models: [],
      headers: {},
    };
  }
  if (config.openaiApiKey && !normalized.openai) {
    normalized.openai = {
      id: "openai",
      type: "openai",
      baseUrl: cleanBaseUrl(config.openaiBaseUrl),
      apiKey: config.openaiApiKey,
      models: [],
      headers: {},
    };
  }
  if (config.deepseekApiKey && !normalized.deepseek) {
    normalized.deepseek = {
      id: "deepseek",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.deepseekBaseUrl),
      apiKey: config.deepseekApiKey,
      models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
      headers: {},
    };
  }
  if (config.dashscopeApiKey && !normalized.dashscope) {
    normalized.dashscope = {
      id: "dashscope",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.dashscopeBaseUrl),
      apiKey: config.dashscopeApiKey,
      models: [config.dashscopeModel || "qwen3-coder-plus"],
      headers: {},
    };
  }
  if (config.kimiApiKey && !normalized.kimi) {
    normalized.kimi = {
      id: "kimi",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.kimiBaseUrl),
      apiKey: config.kimiApiKey,
      models: ["kimi-k2.5"],
      headers: {},
    };
  }
  if (config.glmApiKey && !normalized.glm) {
    normalized.glm = {
      id: "glm",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.glmBaseUrl),
      apiKey: config.glmApiKey,
      models: ["glm-4.7", "glm-4.5-air"],
      headers: {},
    };
  }
  if (config.litellmApiKey && !normalized.litellm) {
    normalized.litellm = {
      id: "litellm",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.litellmBaseUrl),
      apiKey: config.litellmApiKey,
      models: [],
      headers: {},
    };
  }
  if (config.localAnthropicApiKey && config.localAnthropicBaseUrl && !normalized.local) {
    normalized.local = {
      id: "local",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.localAnthropicBaseUrl),
      apiKey: config.localAnthropicApiKey,
      models: [config.localAnthropicModel],
      headers: {},
    };
  }
  return normalized;
}
