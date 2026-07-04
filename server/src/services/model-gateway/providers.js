import { config } from "../../config.js";
import { decryptSecret } from "../security.js";
import { cleanBaseUrl, parseJsonEnv } from "./utils.js";

// DB-backed providers are cached and refreshed in the background so the sync
// listModelGatewayProviders() (called on the /llm hot path) never blocks on a
// query. The DB query is tiny, but a per-request await would ripple through
// every caller's signature. Admin mutations call refreshModelGatewayProviders()
// directly so edits take effect immediately.
const DB_PROVIDER_TTL_MS = 30_000;
let dbProviderCache = { at: 0, map: {} };
let dbRefreshInFlight = null;

function mapDbProviderRow(row) {
  return {
    id: String(row.id),
    label: String(row.label || row.id),
    type: String(row.type || "anthropic").toLowerCase(),
    baseUrl: cleanBaseUrl(row.base_url),
    apiKey: decryptSecret(row.api_key_encrypted),
    // Extra media-provider credentials (e.g. Kling SecretKey). Kept OUT of
    // `headers` because that is spread into upstream HTTP request headers.
    secretKey: decryptSecret(row.secret_key_encrypted),
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {},
    model: String(row.default_model || ""),
    models: Array.isArray(row.models) ? row.models.map(String).filter(Boolean) : [],
    headers: row.headers && typeof row.headers === "object" && !Array.isArray(row.headers) ? row.headers : {},
  };
}

export async function refreshModelGatewayProviders() {
  try {
    // Lazy import so merely importing this module (e.g. for env-provider/
    // client-config logic in tests) does not pull in db.js, which requires
    // DATABASE_URL at load time.
    const { db } = await import("../../db.js");
    const rows = await db
      .selectFrom("model_gateway_providers")
      .selectAll()
      .where("enabled", "=", true)
      .execute();
    const map = {};
    for (const row of rows) map[String(row.id)] = mapDbProviderRow(row);
    dbProviderCache = { at: Date.now(), map };
  } catch {
    // Keep serving the last good map; bump the timestamp to avoid a retry storm.
    dbProviderCache = { at: Date.now(), map: dbProviderCache.map };
  }
  return dbProviderCache.map;
}

function dbProvidersSync() {
  if (Date.now() - dbProviderCache.at > DB_PROVIDER_TTL_MS && !dbRefreshInFlight) {
    dbRefreshInFlight = refreshModelGatewayProviders().finally(() => {
      dbRefreshInFlight = null;
    });
  }
  return dbProviderCache.map;
}

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
    metadata: provider.metadata && typeof provider.metadata === "object" ? provider.metadata : {},
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
      // Strongest first → the default. Authoritative current Claude ids.
      models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
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
  if (config.dashscopeChatApiKey && !normalized.dashscope) {
    normalized.dashscope = {
      id: "dashscope",
      type: "anthropic",
      baseUrl: cleanBaseUrl(config.dashscopeBaseUrl),
      apiKey: config.dashscopeChatApiKey,
      // Flagship general model first (default); keep any env-set DASHSCOPE_MODEL
      // in the list so it stays selectable.
      models: [...new Set(["qwen3.7-max", "qwen3.6-flash", config.dashscopeModel || "qwen3-coder-plus"])],
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
  // DB-configured providers override env per-field so admin-UI edits take
  // effect — but an empty DB apiKey/baseUrl falls back to the env value, so a
  // keyless "default" seed can enrich a provider's model list without disabling
  // one whose key only lives in env.
  for (const [id, dbProvider] of Object.entries(dbProvidersSync())) {
    const envProvider = normalized[id];
    normalized[id] = envProvider
      ? {
          ...envProvider,
          ...dbProvider,
          apiKey: dbProvider.apiKey || envProvider.apiKey,
          baseUrl: dbProvider.baseUrl || envProvider.baseUrl,
          model: dbProvider.model || envProvider.model,
          models: dbProvider.models?.length ? dbProvider.models : envProvider.models,
          metadata: { ...(envProvider.metadata || {}), ...(dbProvider.metadata || {}) },
        }
      : dbProvider;
  }
  return normalized;
}
