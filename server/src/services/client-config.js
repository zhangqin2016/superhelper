import { sha256 } from "./security.js";
import { config } from "../config.js";
import { signModelGatewayToken } from "./model-gateway/auth.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";

export const DEFAULT_EFFECTIVE_CONFIG = {
  schemaVersion: 1,
  models: {
    source: "packaged",
    activePresetId: "",
    presets: [],
  },
  tools: {
    pluginRegistryUrl: "/api/skills/registry",
    enabledPluginIds: [],
  },
  policy: {
    permissionMode: "default",
    minAppVersion: "",
  },
  runtime: {
    env: {},
  },
  taskIntelligence: {
    schemaVersion: 1,
    enabled: true,
    version: "server-default",
    fileExtensions: [],
    priority: [],
    activatingCategories: [],
    categories: {},
    workspaceSignals: [],
    workspaceProfiles: [],
    verificationStrategies: {},
    checklists: {
      base: [],
      byCategory: {},
    },
  },
};

const ENV_MANAGED_PROFILE_ID = "lily-default-runtime";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function deepMerge(base, override) {
  const result = { ...plainObject(base) };
  for (const [key, value] of Object.entries(plainObject(override))) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function firstModel(provider) {
  return provider?.models?.[0] || provider?.model || "";
}

function providerLabel(provider) {
  const labels = {
    anthropic: "Anthropic Gateway",
    openai: "OpenAI Gateway",
    deepseek: "DeepSeek Gateway",
    dashscope: "阿里百炼 Gateway",
    kimi: "Kimi Gateway",
    glm: "GLM Gateway",
    litellm: "LiteLLM Gateway",
    local: "Local Gateway",
  };
  return labels[provider.id] || `${provider.id} Gateway`;
}

function normalizeDeliveryMode(serverConfig) {
  return serverConfig.modelConfigDeliveryMode === "direct" ? "direct" : "gateway";
}

function supportsDirectDelivery(provider) {
  return provider?.type === "anthropic" && /^https?:\/\//i.test(String(provider.baseUrl || ""));
}

function normalizeVisionModel(model) {
  const value = String(model || "").trim();
  if (!value) return "qwen3-vl-plus";
  const legacyAliases = {
    "qwen3.7-plus": "qwen3-vl-plus",
    "qwen3.7-max": "qwen3-vl-plus",
    "qwen3.7-flash": "qwen3-vl-flash",
  };
  return legacyAliases[value.toLowerCase()] || value;
}

function providerPreset(provider, deliveryMode) {
  const model = firstModel(provider);
  if (deliveryMode === "direct" && supportsDirectDelivery(provider)) {
    return {
      id: `${provider.id}-direct`,
      label: providerLabel(provider).replace(/ Gateway$/, " Direct"),
      description: "客户端直连模型供应商。响应更快，但会向客户端下发长期模型密钥。",
      env: {
        LILY_API_BASE_URL: provider.baseUrl,
        LILY_API_KEY: provider.apiKey,
        ...(model ? {
          LILY_MODEL: model,
          LILY_MODEL_HAIKU: provider.models?.[1] || model,
          LILY_MODEL_SONNET: model,
          LILY_MODEL_OPUS: model,
          LILY_SUBAGENT_MODEL: provider.models?.[1] || model,
        } : {}),
      },
    };
  }

  return {
    id: `${provider.id}-gateway`,
    label: providerLabel(provider),
    description: "由 Lily 服务端托管密钥并签发短期访问令牌。",
    env: {
      LILY_API_BASE_URL: `/llm/${provider.id}`,
      LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
      LILY_GATEWAY_PROVIDER: provider.id,
      ...(model ? {
        LILY_MODEL: model,
        LILY_MODEL_HAIKU: provider.models?.[1] || model,
        LILY_MODEL_SONNET: model,
        LILY_MODEL_OPUS: model,
        LILY_SUBAGENT_MODEL: provider.models?.[1] || model,
      } : {}),
    },
  };
}

function runtimeEnvFromServerConfig(serverConfig) {
  const env = {};
  if (serverConfig.dashscopeApiKey) {
    // Note: the raw key is NOT delivered. withGatewayRuntimeConfig injects a
    // short-lived token + proxy base URLs (vision + dashscope-media) at request
    // time, so the client never receives the real DashScope key.
    env.VISION_MODEL = normalizeVisionModel(serverConfig.visionModel);
    env.DASHSCOPE_IMAGE_MODEL = serverConfig.dashscopeImageModel || "qwen-image-2.0-pro";
    env.DASHSCOPE_VIDEO_MODEL = serverConfig.dashscopeVideoModel || "wan2.7-t2v";
    env.DASHSCOPE_TTS_MODEL = serverConfig.dashscopeTtsModel || "cosyvoice-v3-flash";
    env.DASHSCOPE_TTS_VOICE = serverConfig.dashscopeTtsVoice || "longanyang";
    if (serverConfig.dashscopeImageEndpoint) env.DASHSCOPE_IMAGE_ENDPOINT = serverConfig.dashscopeImageEndpoint;
    if (serverConfig.dashscopeVideoEndpoint) env.DASHSCOPE_VIDEO_ENDPOINT = serverConfig.dashscopeVideoEndpoint;
    if (serverConfig.dashscopeTtsEndpoint) env.DASHSCOPE_TTS_ENDPOINT = serverConfig.dashscopeTtsEndpoint;
  }
  return env;
}

// vision/search are media credentials, not chat models — never build chat
// presets for them.
const RESERVED_MODEL_PROVIDER_IDS = new Set(["vision", "search"]);

export function buildEnvManagedClientConfig(serverConfig = config, providers = listModelGatewayProviders(), deliveryModeOverride = null) {
  const deliveryMode = deliveryModeOverride || normalizeDeliveryMode(serverConfig);
  const modelPresets = Object.values(providers || {})
    .filter((provider) => provider?.id && provider?.baseUrl && provider?.apiKey && !RESERVED_MODEL_PROVIDER_IDS.has(provider.id))
    .map((provider) => providerPreset(provider, deliveryMode));

  const activeProviderId = serverConfig.modelGatewayDefaultProvider || modelPresets[0]?.id?.replace(/-gateway$/, "");
  const activePresetId = modelPresets.find((preset) => preset.id === `${activeProviderId}-${deliveryMode}`)?.id
    || modelPresets.find((preset) => preset.id.startsWith(`${activeProviderId}-`))?.id
    || modelPresets[0]?.id
    || "";
  const runtimeEnv = runtimeEnvFromServerConfig(serverConfig);
  const effectiveConfig = {
    schemaVersion: 1,
    ...(modelPresets.length
      ? {
          models: {
            source: "service",
            activePresetId,
            presets: modelPresets,
          },
        }
      : {}),
    tools: {
      pluginRegistryUrl: "/api/skills/registry",
      enabledPluginIds: [
        "lily-vision",
        "lily-image-generation",
        "lily-diagrams",
        "lily-video-generation",
        "lily-speech-generation",
        "websearch",
        "webfetch",
      ],
    },
    policy: {
      permissionMode: "default",
      minAppVersion: "",
    },
    ...(Object.keys(runtimeEnv).length ? { runtime: { env: runtimeEnv } } : {}),
  };

  const hasContent = Boolean(modelPresets.length || Object.keys(runtimeEnv).length);
  return hasContent ? effectiveConfig : null;
}

export async function ensureEnvManagedConfigProfile() {
  const { getModelDeliveryMode } = await import("./app-settings.js");
  const effectiveConfig = buildEnvManagedClientConfig(config, listModelGatewayProviders(), await getModelDeliveryMode());
  if (!effectiveConfig) return { ok: true, skipped: true };
  const { db } = await import("../db.js");
  await db
    .insertInto("config_profiles")
    .values({
      id: ENV_MANAGED_PROFILE_ID,
      name: "Lily 默认运行配置",
      scope: "global",
      target_id: null,
      priority: -100,
      rollout_percent: 100,
      enabled: true,
      config: JSON.stringify(effectiveConfig),
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        name: "Lily 默认运行配置",
        scope: "global",
        target_id: null,
        priority: -100,
        rollout_percent: 100,
        enabled: true,
        config: JSON.stringify(effectiveConfig),
        updated_at: new Date(),
      }),
    )
    .execute();
  return { ok: true, id: ENV_MANAGED_PROFILE_ID };
}

export function rolloutAllows(profile, deviceId) {
  const percent = Number(profile.rollout_percent ?? 100);
  if (!Number.isFinite(percent)) return true;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const hash = sha256(`${profile.id}:${deviceId}`).slice(0, 8);
  const bucket = Number.parseInt(hash, 16) % 100;
  return bucket < percent;
}

function requestBaseUrl(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || request.protocol || "http";
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || request.hostname || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}

export function parseGatewayProvider(baseUrl, env = {}) {
  const explicit = String(env.LILY_GATEWAY_PROVIDER || "").trim();
  if (explicit) return explicit;
  try {
    const parsed = new URL(baseUrl, "https://lily.local");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "llm" && parts[1] && parts[1] !== "v1" && parts[1] !== "messages") return parts[1];
  } catch {
    // Direct model URL validation is handled on the client; an invalid URL just means no gateway provider was inferred.
  }
  return "";
}

export function isGatewayBaseUrl(baseUrl, env = {}) {
  if (env.LILY_GATEWAY_PROVIDER) return true;
  try {
    const parsed = new URL(baseUrl, "https://lily.local");
    return parsed.pathname.split("/").filter(Boolean)[0] === "llm";
  } catch {
    return false;
  }
}

// Minimum client version that forwards WEBSEARCH_IQS_API_URL to the search
// skill. Older clients drop that key (it's not a passthrough prefix), so the
// gateway token would be sent to the real IQS endpoint and rejected — those
// clients must fall back to their local IQS key instead, so we don't inject the
// search proxy for them.
const SEARCH_PROXY_MIN_APP_VERSION = "0.1.37";

function appVersionAtLeast(version, min) {
  const parse = (v) => String(v || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function withGatewayRuntimeConfig(effectiveConfig, request, input, options = {}) {
  const configCopy = JSON.parse(JSON.stringify(effectiveConfig || {}));
  const configuredBaseUrl = String(options.publicBaseUrl || "").trim().replace(/\/+$/, "");
  const base = configuredBaseUrl || requestBaseUrl(request);

  // Route media/search either direct or through the server-side proxies,
  // matching the admin-controlled media delivery mode. Direct is the product
  // default for latency/stability; gateway is explicit when secrets must stay
  // server-side.
  // Picked up by vision-translator (DASHSCOPE_BASE_URL/VISION_API_KEY) and
  // websearch.cjs (WEBSEARCH_IQS_API_URL/WEBSEARCH_IQS_API_KEY) via runtime.env.
  const gatewayProviders = listModelGatewayProviders();
  const visionKey = gatewayProviders.vision?.apiKey || config.dashscopeApiKey;
  const searchKey = gatewayProviders.search?.apiKey || config.webSearchIqsApiKey;
  const searchEnabled = Boolean(searchKey);
  if (base && (visionKey || searchEnabled)) {
    const runtime = configCopy.runtime && typeof configCopy.runtime === "object" ? configCopy.runtime : {};
    const env = runtime.env && typeof runtime.env === "object" ? runtime.env : {};
    if (visionKey) {
      // Media (vision/image/video/TTS) delivery mode is admin-configurable
      // (media_delivery_mode). Default direct: deliver the real DashScope key +
      // real endpoints so the client connects straight to DashScope, no gateway
      // hop (faster, but the key reaches the device). Gateway keeps the key
      // server-side behind /llm/vision + /llm/dashscope-media + a short token.
      if (options.mediaDeliveryMode === "gateway") {
        const visionToken = signModelGatewayToken({
          deviceId: input.deviceId,
          licenseId: input.licenseId || "",
          providerId: "vision",
        });
        env.DASHSCOPE_BASE_URL = `${base}/llm/vision`;
        env.VISION_API_KEY = visionToken;
        env.DASHSCOPE_API_KEY = visionToken;
        env.DASHSCOPE_IMAGE_BASE_URL = `${base}/llm/dashscope-media`;
        env.DASHSCOPE_VIDEO_BASE_URL = `${base}/llm/dashscope-media`;
        env.DASHSCOPE_TTS_BASE_URL = `${base}/llm/dashscope-media`;
      } else {
        env.DASHSCOPE_API_KEY = visionKey;
        env.VISION_API_KEY = visionKey;
        env.DASHSCOPE_BASE_URL = config.visionUpstreamBaseUrl;
        // image/video/TTS skills fall back to their real api/v1 default endpoint.
        delete env.DASHSCOPE_IMAGE_BASE_URL;
        delete env.DASHSCOPE_VIDEO_BASE_URL;
        delete env.DASHSCOPE_TTS_BASE_URL;
      }
    }
    if (searchEnabled) {
      if (options.mediaDeliveryMode === "gateway" && appVersionAtLeast(input.appVersion, SEARCH_PROXY_MIN_APP_VERSION)) {
        env.WEBSEARCH_IQS_API_URL = `${base}/llm/search`;
        env.WEBSEARCH_IQS_API_KEY = signModelGatewayToken({
          deviceId: input.deviceId,
          licenseId: input.licenseId || "",
          providerId: "search",
        });
      } else {
        env.WEBSEARCH_IQS_API_URL = config.webSearchIqsApiUrl;
        env.WEBSEARCH_IQS_API_KEY = searchKey;
      }
    }
    runtime.env = env;
    configCopy.runtime = runtime;
  }

  const presets = configCopy?.models?.presets;
  if (!Array.isArray(presets)) return configCopy;
  for (const preset of presets) {
    const env = preset?.env && typeof preset.env === "object" ? preset.env : null;
    if (!env) continue;
    // Direct delivery: the form ships $LILY_PROVIDER_KEY (it never holds the
    // real key). Inject the provider's real key + endpoint from the registry so
    // the client connects directly to the provider.
    if (env.LILY_API_KEY === "$LILY_PROVIDER_KEY") {
      const provider = gatewayProviders[String(env.LILY_GATEWAY_PROVIDER || "")];
      env.LILY_API_KEY = provider?.apiKey || "";
      if (provider?.baseUrl && !String(env.LILY_API_BASE_URL || "").trim()) {
        env.LILY_API_BASE_URL = provider.baseUrl;
      }
      continue;
    }
    const baseUrl = String(env.LILY_API_BASE_URL || "").trim();
    if (!isGatewayBaseUrl(baseUrl, env)) continue;
    const providerId = parseGatewayProvider(baseUrl, env);
    if (baseUrl.startsWith("/") && base) env.LILY_API_BASE_URL = `${base}${baseUrl}`;
    if (!String(env.LILY_API_KEY || "").trim() || env.LILY_API_KEY === "$LILY_GATEWAY_TOKEN") {
      env.LILY_API_KEY = signModelGatewayToken({
        deviceId: input.deviceId,
        licenseId: input.licenseId || "",
        providerId,
      });
    }
  }
  return configCopy;
}

export function clientConfigTtlMs(serverConfig = config) {
  const maxConfigTtlMs = 24 * 60 * 60 * 1000;
  const gatewayTtlMs = Math.max(60, Number(serverConfig.modelGatewayTokenTtlSeconds) || 3600) * 1000;
  const gatewaySafeTtlMs = Math.max(30 * 1000, gatewayTtlMs - 60 * 1000);
  return Math.min(maxConfigTtlMs, gatewaySafeTtlMs);
}
