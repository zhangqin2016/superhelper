import { sha256 } from "./security.js";
import { config } from "../config.js";
import { verifyAccessToken } from "./account-auth.js";
import { signModelGatewayToken } from "./model-gateway/auth.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";
import { discoveredModelMetadataSync, discoveredModelsSync } from "./model-gateway/model-discovery.js";
import { normalizeProviderForProtocol } from "./model-gateway/model-aliases.js";
import { getModelCatalog } from "./model-catalog.js";
import { resolveModelRuntimeBudget } from "./model-runtime-budget.js";
import { buildMediaProviderContracts } from "./media-provider-contracts.js";

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
const ENV_MANAGED_PROFILE_DELETED_KEY = "env_managed_config_profile_deleted";
const DELETED_CONFIG_PROFILE_IDS_KEY = "deleted_config_profile_ids";

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

/**
 * Resolve the per-scope image/video/speech generation selection (multi-select + default)
 * against the providers the server can actually serve. PURELY ADDITIVE + FAIL-OPEN: a
 * profile with no `config.media` (every old profile) is left to deliver exactly today's
 * behavior — all key-backed providers, server default — and old clients simply ignore
 * the extra `media` field. So new server + old client and old profile + new client both
 * keep working. `availability` = media-gen provider ids whose key exists server-side.
 */
export function resolveMediaSelection(configCopy, availability) {
  const unique = (list) => [...new Set((list || []).filter(Boolean).map(String))];
  const all = Array.isArray(availability) ? unique(availability) : unique(availability?.all);
  const available = {
    image: unique(Array.isArray(availability) ? availability : availability?.image || all),
    video: unique(Array.isArray(availability) ? availability : availability?.video || all),
    speech: unique(Array.isArray(availability) ? all.filter((p) => p === "dashscope") : availability?.speech || availability?.tts || all.filter((p) => p === "dashscope")),
  };
  const avail = [...new Set([...available.image, ...available.video, ...available.speech])];
  if (!avail.length) return configCopy; // server can't serve any media — leave as today
  const requested = configCopy && typeof configCopy.media === "object" ? configCopy.media : null;
  const env = configCopy?.runtime?.env && typeof configCopy.runtime.env === "object" ? configCopy.runtime.env : null;
  const resolveKind = (kind) => {
    const kindAvail = available[kind] || [];
    if (!kindAvail.length) return null;
    const req = requested?.[kind];
    const list = Array.isArray(req?.providers) ? req.providers.map(String).filter(Boolean) : [];
    let providers = list.filter((p) => kindAvail.includes(p));
    if (!providers.length) providers = [...kindAvail];
    const serverDefault = String(
      (kind === "image" ? env?.LILY_IMAGE_PROVIDER : kind === "video" ? env?.LILY_VIDEO_PROVIDER : env?.LILY_SPEECH_PROVIDER || env?.LILY_TTS_PROVIDER) || "",
    );
    let def = String(req?.default || "");
    if (!providers.includes(def)) def = providers.includes(serverDefault) ? serverDefault : providers[0];
    return { providers, default: def };
  };
  const resolved = {};
  for (const kind of ["image", "video", "speech"]) {
    const next = resolveKind(kind);
    if (next) resolved[kind] = next;
  }
  configCopy.media = { ...(requested || {}), ...resolved };
  if (env) {
    // Make the resolved default actually drive the generation skill dispatch.
    if (resolved.image?.default) env.LILY_IMAGE_PROVIDER = resolved.image.default;
    if (resolved.video?.default) env.LILY_VIDEO_PROVIDER = resolved.video.default;
    if (resolved.speech?.default) env.LILY_SPEECH_PROVIDER = resolved.speech.default;
  }
  return configCopy;
}

function hasLilyMedia(configCopy, kind) {
  const env = configCopy?.runtime?.env && typeof configCopy.runtime.env === "object" ? configCopy.runtime.env : {};
  if (env.LILY_MEDIA_BASE_URL || env.LILY_GPU_BASE_URL) return true;
  if (kind === "image") return Boolean(env.LILY_MEDIA_IMAGE_ENDPOINT || env.LILY_MEDIA_IMAGE_BASE_URL || env.LILY_GPU_IMAGE_ENDPOINT || env.LILY_GPU_IMAGE_BASE_URL);
  if (kind === "video") return Boolean(env.LILY_MEDIA_VIDEO_ENDPOINT || env.LILY_MEDIA_VIDEO_BASE_URL || env.LILY_GPU_VIDEO_ENDPOINT || env.LILY_GPU_VIDEO_BASE_URL);
  if (kind === "speech") return Boolean(env.LILY_MEDIA_SPEECH_ENDPOINT || env.LILY_MEDIA_SPEECH_BASE_URL || env.LILY_MEDIA_TTS_ENDPOINT || env.LILY_MEDIA_TTS_BASE_URL || env.LILY_GPU_SPEECH_ENDPOINT || env.LILY_GPU_SPEECH_BASE_URL || env.LILY_GPU_TTS_ENDPOINT || env.LILY_GPU_TTS_BASE_URL);
  return false;
}

function configuredLilyMediaKinds(serverConfig = config) {
  const shared = Boolean(serverConfig.lilyMediaBaseUrl);
  return {
    image: shared || Boolean(serverConfig.lilyMediaImageEndpoint || serverConfig.lilyMediaImageBaseUrl),
    video: shared || Boolean(serverConfig.lilyMediaVideoEndpoint || serverConfig.lilyMediaVideoBaseUrl),
    speech: shared || Boolean(serverConfig.lilyMediaSpeechEndpoint || serverConfig.lilyMediaSpeechBaseUrl),
  };
}

function applyDirectLilyMediaEnv(env, serverConfig = config) {
  if (serverConfig.lilyMediaApiKey) env.LILY_MEDIA_API_KEY = serverConfig.lilyMediaApiKey;
  if (serverConfig.lilyMediaBaseUrl) env.LILY_MEDIA_BASE_URL = serverConfig.lilyMediaBaseUrl;
  if (serverConfig.lilyMediaImageBaseUrl) env.LILY_MEDIA_IMAGE_BASE_URL = serverConfig.lilyMediaImageBaseUrl;
  if (serverConfig.lilyMediaVideoBaseUrl) env.LILY_MEDIA_VIDEO_BASE_URL = serverConfig.lilyMediaVideoBaseUrl;
  if (serverConfig.lilyMediaSpeechBaseUrl) env.LILY_MEDIA_SPEECH_BASE_URL = serverConfig.lilyMediaSpeechBaseUrl;
  if (serverConfig.lilyMediaImageEndpoint) env.LILY_MEDIA_IMAGE_ENDPOINT = serverConfig.lilyMediaImageEndpoint;
  if (serverConfig.lilyMediaVideoEndpoint) env.LILY_MEDIA_VIDEO_ENDPOINT = serverConfig.lilyMediaVideoEndpoint;
  if (serverConfig.lilyMediaSpeechEndpoint) env.LILY_MEDIA_SPEECH_ENDPOINT = serverConfig.lilyMediaSpeechEndpoint;
}

/** A provider's selectable models: the explicit `models` list, else its single
 *  default model. Empty only when the provider declares no model at all. */
function providerModelList(provider) {
  const list = Array.isArray(provider?.models) ? provider.models.map(String).filter(Boolean) : [];
  const base = list.length ? list : provider?.model ? [String(provider.model)] : [];
  // Augment with auto-discovered models (opt-in; [] when off/unavailable). The
  // configured list stays first so order/default are preserved — discovery only
  // appends models the operator didn't list, never removes any.
  let discovered = [];
  try {
    discovered = discoveredModelsSync(provider);
  } catch {
    discovered = [];
  }
  if (!discovered.length) return base;
  const merged = [...base];
  for (const model of discovered) if (!merged.includes(model)) merged.push(model);
  return merged;
}

/** The model a provider defaults to: its explicit `default_model` when it's part
 *  of the list, otherwise the first listed model. (Previously the first model
 *  always won, silently ignoring a configured default — fixed here.) */
function defaultModelFor(provider) {
  const models = providerModelList(provider);
  if (!models.length) return "";
  const def = String(provider?.model || "");
  return def && models.includes(def) ? def : models[0];
}

function providerVisionCapability(provider, providerCapabilities = {}) {
  const explicit = providerCapabilities?.[provider?.id]?.vision;
  // Provider metadata is the current source of truth from the model-provider
  // registry. Older config profiles may carry a generated `vision:false` from
  // before the provider was marked native-vision; that stale false must not
  // suppress the newer provider capability.
  return Boolean(explicit || provider?.metadata?.nativeVision || provider?.capabilities?.vision);
}

function modelSlug(model) {
  return String(model || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function modelMetadata(provider, model) {
  const metadata = provider?.metadata && typeof provider.metadata === "object" ? provider.metadata : {};
  const modelId = String(model || provider?.model || "").trim();
  const discovered = discoveredModelMetadataSync(provider, modelId);
  const models = metadata.models && typeof metadata.models === "object" && !Array.isArray(metadata.models)
    ? metadata.models
    : {};
  const modelSpecific = modelId && models[modelId] && typeof models[modelId] === "object" && !Array.isArray(models[modelId])
    ? models[modelId]
    : {};
  return { metadata, discovered, modelSpecific };
}

function providerModelEnv(provider, model) {
  const { discovered } = modelMetadata(provider, model);
  const { contextWindowTokens, maxOutputTokens } = resolveModelRuntimeBudget(provider, model, discovered);
  return {
    ...(contextWindowTokens ? { LILY_CONTEXT_WINDOW_TOKENS: String(contextWindowTokens) } : {}),
    ...(maxOutputTokens ? { LILY_MAX_OUTPUT_TOKENS: String(maxOutputTokens) } : {}),
  };
}

function providerLabel(provider) {
  // Honor the operator-configured label first (DB model_gateway_providers.label /
  // MODEL_GATEWAY_PROVIDERS). The static id→name map and the bare-id form are only
  // fallbacks for env-seeded providers that carry no label — otherwise a provider
  // whose id happens to be "deepseek" but actually serves another backend would be
  // mislabeled "DeepSeek" no matter what the admin named it.
  // Plain vendor names — no "Gateway"/"Direct" suffix. Delivery mode is an
  // internal detail (kept in the preset id/env), not something end users should
  // see in the model picker.
  const fallback = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    deepseek: "DeepSeek",
    dashscope: "阿里百炼",
    kimi: "Kimi",
    glm: "GLM",
    litellm: "LiteLLM",
    local: "Local",
  };
  // Use the operator's label only when it's a real custom name (DB rows default
  // label to the id, which should still map to the nice built-in name).
  const custom = String(provider.label || "").trim();
  if (custom && custom !== provider.id) return custom;
  return fallback[provider.id] || provider.id;
}

function normalizeDeliveryMode(serverConfig) {
  return serverConfig.modelConfigDeliveryMode === "direct" ? "direct" : "gateway";
}

function supportsDirectDelivery(provider) {
  return ["anthropic", "openai"].includes(provider?.type) && /^https?:\/\//i.test(String(provider.baseUrl || ""));
}

function opencodeProtocolFor(provider, deliveryMode) {
  // The Lily gateway exposes both Anthropic-compatible /messages and native
  // OpenAI-compatible /chat/completions. Keep each provider on its own protocol
  // so OpenAI tool_calls can pass through without lossy conversion.
  if (provider?.type === "openai") return "openai";
  if (deliveryMode !== "direct") return "anthropic";
  return provider?.type === "openai" ? "openai" : "anthropic";
}

function opencodeProviderSpecFor(provider, deliveryMode) {
  const protocol = opencodeProtocolFor(provider, deliveryMode);
  return protocol === "openai"
    ? { protocol, providerId: "lily", npm: "@ai-sdk/openai-compatible" }
    : { protocol, providerId: "anthropic", npm: "@ai-sdk/anthropic" };
}

function gatewayBaseUrlFor(provider) {
  const base = `/llm/${provider.id}`;
  return provider?.type === "openai" ? `${base}/v1` : base;
}

function normalizeVisionModel(model) {
  const value = String(model || "").trim();
  if (!value) return "qwen-vl-max";
  const legacyAliases = {
    "qwen3.7-plus": "qwen-vl-max",
    "qwen3.7-max": "qwen-vl-max",
    "qwen3.7-flash": "qwen3-vl-flash",
  };
  return legacyAliases[value.toLowerCase()] || value;
}

/** Build ONE preset for a specific model. The provider's default model keeps the
 *  bare `${id}-${mode}` preset id (so a stored activePresetId stays valid and the
 *  active-preset resolution below still matches); extra models get a suffixed id.
 *  All OpenCode model tiers map to the same model (the engine runs one model). */
function providerPreset(provider, deliveryMode, model, isDefault, providerCapabilities = {}) {
  const capabilities = { vision: providerVisionCapability(provider, providerCapabilities) };
  const modelEnv = model
    ? {
        LILY_MODEL: model,
        LILY_MODEL_HAIKU: model,
        LILY_MODEL_SONNET: model,
        LILY_MODEL_OPUS: model,
        LILY_SUBAGENT_MODEL: model,
      }
    : {};
  const metadataEnv = providerModelEnv(provider, model);
  const suffix = isDefault ? "" : `--${modelSlug(model)}`;
  if (deliveryMode === "direct" && supportsDirectDelivery(provider)) {
    const opencode = opencodeProviderSpecFor(provider, deliveryMode);
    return {
      id: `${provider.id}-direct${suffix}`,
      label: providerLabel(provider),
      description: "客户端直连模型供应商。响应更快，但会向客户端下发长期模型密钥。",
      capabilities,
      env: {
        LILY_API_BASE_URL: provider.baseUrl,
        LILY_OPENCODE_BASE_URL: provider.baseUrl,
        LILY_API_KEY: provider.apiKey,
        LILY_OPENCODE_PROTOCOL: opencode.protocol,
        LILY_OPENCODE_PROVIDER_ID: opencode.providerId,
        LILY_OPENCODE_PROVIDER_NPM: opencode.npm,
        ...modelEnv,
        ...metadataEnv,
      },
    };
  }

  const effectiveDeliveryMode = "gateway";
  const gatewayBaseUrl = gatewayBaseUrlFor(provider);
  const opencode = opencodeProviderSpecFor(provider, effectiveDeliveryMode);
  return {
    id: `${provider.id}-gateway${suffix}`,
    label: providerLabel(provider),
    description: "由 Lily 服务端托管密钥并签发短期访问令牌。",
    capabilities,
    env: {
      LILY_API_BASE_URL: gatewayBaseUrl,
      LILY_OPENCODE_BASE_URL: gatewayBaseUrl,
      LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
      LILY_GATEWAY_PROVIDER: provider.id,
      LILY_OPENCODE_PROTOCOL: opencode.protocol,
      LILY_OPENCODE_PROVIDER_ID: opencode.providerId,
      LILY_OPENCODE_PROVIDER_NPM: opencode.npm,
      ...modelEnv,
      ...metadataEnv,
    },
  };
}

/** Every selectable model for a provider becomes its own preset, so the client's
 *  model dropdown can offer them all. The default model is marked so it keeps the
 *  bare preset id and becomes the activePresetId. A provider with no model still
 *  yields one (model-less) preset, preserving prior behavior. */
function providerPresets(provider, deliveryMode, providerCapabilities = {}) {
  const models = providerModelList(provider);
  if (!models.length) return [providerPreset(provider, deliveryMode, "", true, providerCapabilities)];
  const def = defaultModelFor(provider);
  return models.map((model) => providerPreset(provider, deliveryMode, model, model === def, providerCapabilities));
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
  // Volcengine Ark (Seedream/Seedance) non-secret config. The key itself is
  // injected by withGatewayRuntimeConfig (token in gateway mode, real key in
  // direct mode) — never delivered here.
  if (serverConfig.volcengineApiKey) {
    env.VOLCENGINE_IMAGE_MODEL = serverConfig.volcengineImageModel || "doubao-seedream-4-0-250828";
    env.VOLCENGINE_VIDEO_MODEL = serverConfig.volcengineVideoModel || "doubao-seedance-1-0-lite-t2v-250428";
  }
  // Kling / MiniMax / Zhipu non-secret model config (keys injected at request
  // time by withGatewayRuntimeConfig — never delivered here).
  if (serverConfig.klingAccessKey) {
    env.KLING_IMAGE_MODEL = serverConfig.klingImageModel || "kling-v1-5";
    env.KLING_VIDEO_MODEL = serverConfig.klingVideoModel || "kling-v1-6";
  }
  if (serverConfig.minimaxApiKey) {
    env.MINIMAX_IMAGE_MODEL = serverConfig.minimaxImageModel || "image-01";
    env.MINIMAX_VIDEO_MODEL = serverConfig.minimaxVideoModel || "MiniMax-Hailuo-2.3";
  }
  if (serverConfig.zhipuApiKey) {
    env.ZHIPU_IMAGE_MODEL = serverConfig.zhipuImageModel || "cogview-4-250304";
    env.ZHIPU_VIDEO_MODEL = serverConfig.zhipuVideoModel || "cogvideox-3";
  }
  if (serverConfig.lilyMediaApiKey) env.LILY_MEDIA_API_KEY = serverConfig.lilyMediaApiKey;
  if (serverConfig.lilyMediaBaseUrl) env.LILY_MEDIA_BASE_URL = serverConfig.lilyMediaBaseUrl;
  if (serverConfig.lilyMediaImageBaseUrl) env.LILY_MEDIA_IMAGE_BASE_URL = serverConfig.lilyMediaImageBaseUrl;
  if (serverConfig.lilyMediaVideoBaseUrl) env.LILY_MEDIA_VIDEO_BASE_URL = serverConfig.lilyMediaVideoBaseUrl;
  if (serverConfig.lilyMediaSpeechBaseUrl) env.LILY_MEDIA_SPEECH_BASE_URL = serverConfig.lilyMediaSpeechBaseUrl;
  if (serverConfig.lilyMediaImageEndpoint) env.LILY_MEDIA_IMAGE_ENDPOINT = serverConfig.lilyMediaImageEndpoint;
  if (serverConfig.lilyMediaVideoEndpoint) env.LILY_MEDIA_VIDEO_ENDPOINT = serverConfig.lilyMediaVideoEndpoint;
  if (serverConfig.lilyMediaSpeechEndpoint) env.LILY_MEDIA_SPEECH_ENDPOINT = serverConfig.lilyMediaSpeechEndpoint;
  // Default media provider for the image/video skills (per-call overridable via
  // input.provider). Drives the dispatch shell in generate-image/video.cjs.
  env.LILY_IMAGE_PROVIDER = serverConfig.mediaImageProvider || "dashscope";
  env.LILY_VIDEO_PROVIDER = serverConfig.mediaVideoProvider || "dashscope";
  env.LILY_SPEECH_PROVIDER = serverConfig.mediaSpeechProvider || "dashscope";
  return env;
}

// vision/search and *-media are media credentials, not chat models — never
// build chat presets for them.
const RESERVED_MODEL_PROVIDER_IDS = new Set([
  "vision",
  "search",
  "volcengine-media",
  "kling-media",
  "minimax-media",
  "zhipu-media",
]);

export function buildEnvManagedClientConfig(serverConfig = config, providers = listModelGatewayProviders(), deliveryModeOverride = null) {
  const deliveryMode = deliveryModeOverride || normalizeDeliveryMode(serverConfig);
  // The server config is the visible model boundary. Empty allow-list means no
  // narrowing; an explicit allow-list narrows exactly. If an explicit list
  // matches nothing, fail closed instead of leaking another provider.
  const configuredAllow = Array.isArray(serverConfig.defaultModelProviders)
    ? serverConfig.defaultModelProviders.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  const exposeAllProviders = configuredAllow.some((value) => value === "*" || value.toLowerCase() === "all");
  const explicitAllow = configuredAllow.length > 0 && !exposeAllProviders;
  const allowedProviderIds = explicitAllow ? configuredAllow.map((value) => value.toLowerCase()) : [];
  const configuredChatProviders = Object.values(providers || {}).filter(
    (provider) =>
      provider?.id &&
      provider?.baseUrl &&
      provider?.apiKey &&
      !RESERVED_MODEL_PROVIDER_IDS.has(provider.id),
  );
  const visibleChatProviders = explicitAllow
    ? configuredChatProviders.filter((provider) => allowedProviderIds.includes(String(provider.id).toLowerCase()))
    : configuredChatProviders;
  const modelProviders = visibleChatProviders.map((provider) => normalizeProviderForProtocol(provider));
  const modelPresets = modelProviders
    .flatMap((provider) => providerPresets(provider, deliveryMode));

  const activeProviderId = serverConfig.modelGatewayDefaultProvider || modelPresets[0]?.id?.replace(/-gateway$/, "");
  const activePresetId = modelPresets.find((preset) => preset.id === `${activeProviderId}-${deliveryMode}`)?.id
    || modelPresets.find((preset) => preset.id.startsWith(`${activeProviderId}-`))?.id
    || modelPresets[0]?.id
    || "";

  // BYOK provider catalog: a rich, current list of public providers + their
  // endpoints/protocols/models (NO keys), sourced from models.dev and cached
  // server-side (see services/model-catalog). The client uses it so the user
  // just picks a provider + model and enters their own key — no manual base URL
  // / model ID typing. Falls back to the vendored snapshot if the live fetch
  // never succeeded.
  const catalog = getModelCatalog();
  const visibleCatalog = explicitAllow
    ? catalog.filter((provider) => allowedProviderIds.includes(String(provider?.id || "").toLowerCase()))
    : catalog;

  const runtimeEnv = runtimeEnvFromServerConfig(serverConfig);
  const effectiveConfig = {
    schemaVersion: 1,
    ...(modelPresets.length
      ? {
          models: {
            source: "service",
            activePresetId,
            presets: modelPresets,
            ...(visibleCatalog.length ? { catalog: visibleCatalog } : {}),
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
  const { getAppSetting, getModelDeliveryMode } = await import("./app-settings.js");
  const effectiveConfig = buildEnvManagedClientConfig(config, listModelGatewayProviders(), await getModelDeliveryMode());
  if (!effectiveConfig) return { ok: true, skipped: true };
  const { db } = await import("../db.js");
  const existing = await db
    .selectFrom("config_profiles")
    .select("id")
    .where("id", "=", ENV_MANAGED_PROFILE_ID)
    .executeTakeFirst();
  const anyProfile = existing
    ? existing
    : await db.selectFrom("config_profiles").select("id").limit(1).executeTakeFirst();
  const deleted = Boolean(await getAppSetting(ENV_MANAGED_PROFILE_DELETED_KEY, false));
  const decision = decideEnvManagedConfigProfileWrite({
    hasEffectiveConfig: true,
    profileExists: Boolean(existing),
    anyProfileExists: Boolean(anyProfile),
    deleted,
  });
  if (decision.action === "skip") return { ok: true, skipped: true, reason: decision.reason };
  const values = {
    name: "Lily 默认运行配置",
    scope: "global",
    target_id: null,
    priority: -100,
    rollout_percent: 100,
    enabled: true,
    config: JSON.stringify(effectiveConfig),
    updated_at: new Date(),
  };
  if (decision.action === "update") {
    await db.updateTable("config_profiles").set(values).where("id", "=", ENV_MANAGED_PROFILE_ID).execute();
    return { ok: true, id: ENV_MANAGED_PROFILE_ID, action: "updated" };
  }
  await db
    .insertInto("config_profiles")
    .values({
      id: ENV_MANAGED_PROFILE_ID,
      ...values,
    })
    .execute();
  return { ok: true, id: ENV_MANAGED_PROFILE_ID, action: "created" };
}

export function decideEnvManagedConfigProfileWrite(input = {}) {
  if (!input.hasEffectiveConfig) return { action: "skip", reason: "no_effective_config" };
  if (input.profileExists) return { action: "update" };
  if (input.deleted) return { action: "skip", reason: "deleted_by_admin" };
  if (input.anyProfileExists) return { action: "skip", reason: "existing_profiles_without_seed" };
  return { action: "create" };
}

export async function recordEnvManagedConfigProfileDeleted(profileId) {
  if (profileId !== ENV_MANAGED_PROFILE_ID) return false;
  const { setAppSetting } = await import("./app-settings.js");
  await setAppSetting(ENV_MANAGED_PROFILE_DELETED_KEY, true);
  return true;
}

export function decideConfigProfileUpsert(input = {}) {
  // Deletion tombstones suppress automatic/default profile resurrection only.
  // Admins must still be able to intentionally recreate a rule with the same id;
  // otherwise a deleted id becomes permanently unusable and the UI cannot save
  // a perfectly valid replacement.
  return { ok: true };
}

export async function configProfileWasDeleted(profileId) {
  const { getAppSetting } = await import("./app-settings.js");
  const ids = await getAppSetting(DELETED_CONFIG_PROFILE_IDS_KEY, []);
  return Array.isArray(ids) && ids.map(String).includes(String(profileId || ""));
}

export async function recordConfigProfileDeleted(profileId) {
  const id = String(profileId || "").trim();
  if (!id) return false;
  const { getAppSetting, setAppSetting } = await import("./app-settings.js");
  const current = await getAppSetting(DELETED_CONFIG_PROFILE_IDS_KEY, []);
  const ids = new Set(Array.isArray(current) ? current.map(String).filter(Boolean) : []);
  ids.add(id);
  await setAppSetting(DELETED_CONFIG_PROFILE_IDS_KEY, [...ids].sort());
  return true;
}

export async function clearConfigProfileDeleted(profileId) {
  const id = String(profileId || "").trim();
  if (!id) return false;
  const { getAppSetting, setAppSetting } = await import("./app-settings.js");
  const current = await getAppSetting(DELETED_CONFIG_PROFILE_IDS_KEY, []);
  const ids = new Set(Array.isArray(current) ? current.map(String).filter(Boolean) : []);
  if (!ids.delete(id)) return false;
  await setAppSetting(DELETED_CONFIG_PROFILE_IDS_KEY, [...ids].sort());
  return true;
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

// Per-scope model menu: a config profile may carry `models.providers` (an array
// of provider ids) + optional `models.activeProvider` instead of a fixed preset
// list. At delivery we expand that into the real preset menu for those providers
// (reusing providerPresets), which — thanks to deepMerge replacing arrays — lets
// each scope (group/device/license) define its own selectable model set on top
// of the minimal global baseline. Fail-safe: if none of the listed providers are
// configured/keyed, we drop the directive and keep whatever menu was already
// resolved (baseline) — never deliver an empty picker.
export function expandModelProviderMenu(effectiveConfig, options = {}) {
  const models = effectiveConfig?.models;
  const directive = Array.isArray(models?.providers) ? models.providers.map(String).filter(Boolean) : null;
  if (!directive || !directive.length) return effectiveConfig;
  const deliveryMode = options.deliveryMode || "gateway";
  const providers = options.providers || listModelGatewayProviders();
  const allow = new Set(directive);
  const presets = Object.values(providers || {})
    .filter(
      (provider) =>
        provider?.id &&
        provider?.baseUrl &&
        provider?.apiKey &&
        !RESERVED_MODEL_PROVIDER_IDS.has(provider.id) &&
        allow.has(provider.id),
    )
    .flatMap((provider) => providerPresets(provider, deliveryMode, models.capabilities || {}));
  const { providers: _providers, activeProvider, ...restModels } = models;
  if (!presets.length) return { ...effectiveConfig, models: restModels };
  const active = String(activeProvider || directive[0]);
  const activePresetId =
    presets.find((preset) => preset.id === `${active}-${deliveryMode}`)?.id ||
    presets.find((preset) => preset.id.startsWith(`${active}-`))?.id ||
    presets[0].id;
  return { ...effectiveConfig, models: { ...restModels, source: "service", activePresetId, presets } };
}

export function withGatewayRuntimeConfig(effectiveConfig, request, input, options = {}) {
  const configCopy = JSON.parse(JSON.stringify(effectiveConfig || {}));
  const configuredBaseUrl = String(options.policyBaseUrl || options.publicBaseUrl || "").trim().replace(/\/+$/, "");
  const base = configuredBaseUrl || requestBaseUrl(request);
  const account = options.account && typeof options.account === "object" ? options.account : {};
  const signMediaToken = (providerId) =>
    signModelGatewayToken({
      deviceId: input.deviceId,
      licenseId: input.licenseId || "",
      providerId,
      userId: account.userId || "",
      sessionId: account.sessionId || "",
    });

  // Route media/search either direct or through the server-side proxies,
  // matching the admin-controlled media delivery mode. Direct is the product
  // default for latency/stability; gateway is explicit when secrets must stay
  // server-side.
  // Picked up by vision-translator (DASHSCOPE_BASE_URL/VISION_API_KEY) and
  // websearch.cjs (WEBSEARCH_IQS_API_URL/WEBSEARCH_IQS_API_KEY) via runtime.env.
  const gatewayProviders = listModelGatewayProviders();
  const visionKey = gatewayProviders.vision?.apiKey || config.dashscopeApiKey;
  const searchKey = gatewayProviders.search?.apiKey || config.webSearchIqsApiKey;
  const volcengineKey = gatewayProviders["volcengine-media"]?.apiKey || config.volcengineApiKey;
  const klingAccessKey = gatewayProviders["kling-media"]?.apiKey || config.klingAccessKey;
  const minimaxKey = gatewayProviders["minimax-media"]?.apiKey || config.minimaxApiKey;
  const zhipuKey = gatewayProviders["zhipu-media"]?.apiKey || config.zhipuApiKey;
  const searchEnabled = Boolean(searchKey);
  if (base && (visionKey || searchEnabled || volcengineKey || klingAccessKey || minimaxKey || zhipuKey)) {
    const runtime = configCopy.runtime && typeof configCopy.runtime === "object" ? configCopy.runtime : {};
    const env = runtime.env && typeof runtime.env === "object" ? runtime.env : {};
    if (visionKey) {
      env.VISION_MODEL = normalizeVisionModel(env.VISION_MODEL || config.visionModel);
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
          userId: account.userId || "",
          sessionId: account.sessionId || "",
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
          userId: account.userId || "",
          sessionId: account.sessionId || "",
        });
      } else {
        env.WEBSEARCH_IQS_API_URL = config.webSearchIqsApiUrl;
        env.WEBSEARCH_IQS_API_KEY = searchKey;
      }
    }
    // Bearer-key media providers (Ark / MiniMax / Zhipu). Same gateway/direct
    // split as DashScope media: gateway keeps the key server-side behind
    // /llm/media/<route> + a short token; direct delivers the real key + endpoint
    // so the client connects straight to the provider.
    const gatewayMode = options.mediaDeliveryMode === "gateway";
    const bearerMedia = [
      { key: volcengineKey, route: "volcengine", providerId: "volcengine-media", keyEnv: "VOLCENGINE_API_KEY", baseEnv: "VOLCENGINE_BASE_URL", directBaseUrl: gatewayProviders["volcengine-media"]?.baseUrl || config.volcengineBaseUrl },
      { key: minimaxKey, route: "minimax", providerId: "minimax-media", keyEnv: "MINIMAX_API_KEY", baseEnv: "MINIMAX_BASE_URL", directBaseUrl: gatewayProviders["minimax-media"]?.baseUrl || config.minimaxBaseUrl, directExtra: (e) => { if (config.minimaxGroupId) e.MINIMAX_GROUP_ID = config.minimaxGroupId; } },
      { key: zhipuKey, route: "zhipu", providerId: "zhipu-media", keyEnv: "ZHIPU_API_KEY", baseEnv: "ZHIPU_BASE_URL", directBaseUrl: gatewayProviders["zhipu-media"]?.baseUrl || config.zhipuBaseUrl },
    ];
    for (const p of bearerMedia) {
      if (!p.key) continue;
      if (gatewayMode) {
        env[p.baseEnv] = `${base}/llm/media/${p.route}`;
        env[p.keyEnv] = signMediaToken(p.providerId);
      } else {
        env[p.keyEnv] = p.key;
        env[p.baseEnv] = p.directBaseUrl;
        if (p.directExtra) p.directExtra(env);
      }
    }
    // Kling uses JWT auth. Gateway: deliver a short token + proxy URL — the
    // server signs the real JWT (SecretKey never leaves). Direct/BYOK: deliver
    // AccessKey + SecretKey so the client signs the JWT locally.
    if (klingAccessKey) {
      if (gatewayMode) {
        env.KLING_BASE_URL = `${base}/llm/media/kling`;
        env.KLING_API_KEY = signMediaToken("kling-media");
      } else {
        env.KLING_BASE_URL = gatewayProviders["kling-media"]?.baseUrl || config.klingBaseUrl;
        env.KLING_ACCESS_KEY = klingAccessKey;
        env.KLING_SECRET_KEY = config.klingSecretKey;
      }
    }
    runtime.env = env;
    configCopy.runtime = runtime;
  }

  const lilyKinds = configuredLilyMediaKinds(config);
  if (lilyKinds.image || lilyKinds.video || lilyKinds.speech) {
    const runtime = configCopy.runtime && typeof configCopy.runtime === "object" ? configCopy.runtime : {};
    const env = runtime.env && typeof runtime.env === "object" ? runtime.env : {};
    env.LILY_IMAGE_PROVIDER = env.LILY_IMAGE_PROVIDER || config.mediaImageProvider || "dashscope";
    env.LILY_VIDEO_PROVIDER = env.LILY_VIDEO_PROVIDER || config.mediaVideoProvider || "dashscope";
    env.LILY_SPEECH_PROVIDER = env.LILY_SPEECH_PROVIDER || config.mediaSpeechProvider || "dashscope";
    if (options.mediaDeliveryMode === "gateway" && base) {
      env.LILY_MEDIA_API_KEY = signMediaToken("lily-media");
      if (lilyKinds.image) env.LILY_MEDIA_IMAGE_ENDPOINT = `${base}/llm/media/lily/image/generate`;
      if (lilyKinds.video) env.LILY_MEDIA_VIDEO_ENDPOINT = `${base}/llm/media/lily/video/generate`;
      if (lilyKinds.speech) env.LILY_MEDIA_SPEECH_ENDPOINT = `${base}/llm/media/lily/speech/generate`;
      delete env.LILY_MEDIA_BASE_URL;
      delete env.LILY_MEDIA_IMAGE_BASE_URL;
      delete env.LILY_MEDIA_VIDEO_BASE_URL;
      delete env.LILY_MEDIA_SPEECH_BASE_URL;
    } else {
      applyDirectLilyMediaEnv(env, config);
    }
    runtime.env = env;
    configCopy.runtime = runtime;
  }

  // Per-scope media-generation selection (multi-select + default), gated by which media
  // providers actually have a key server-side. Additive + fail-open (see helper).
  const availableImageVideoProviders = [
    visionKey ? "dashscope" : null,
    volcengineKey ? "volcengine" : null,
    klingAccessKey ? "kling" : null,
    minimaxKey ? "minimax" : null,
    zhipuKey ? "zhipu" : null,
  ];
  const availableImageProviders = [...availableImageVideoProviders];
  const availableVideoProviders = [...availableImageVideoProviders];
  if (hasLilyMedia(configCopy, "image")) availableImageProviders.push("lily");
  if (hasLilyMedia(configCopy, "video")) availableVideoProviders.push("lily");
  const availableSpeechProviders = visionKey ? ["dashscope"] : [];
  if (hasLilyMedia(configCopy, "speech")) availableSpeechProviders.push("lily");
  const availableMediaProviders = {
    image: availableImageProviders,
    video: availableVideoProviders,
    speech: availableSpeechProviders,
  };
  resolveMediaSelection(configCopy, availableMediaProviders);
  if (configCopy.media && typeof configCopy.media === "object") {
    configCopy.media.contracts = buildMediaProviderContracts({
      selected: {
        image: configCopy.media.image?.default || "",
        video: configCopy.media.video?.default || "",
        speech: configCopy.media.speech?.default || "",
      },
      available: availableMediaProviders,
    });
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
    const opencodeBaseUrl = String(env.LILY_OPENCODE_BASE_URL || "").trim();
    if (opencodeBaseUrl.startsWith("/") && base) env.LILY_OPENCODE_BASE_URL = `${base}${opencodeBaseUrl}`;
    if (!String(env.LILY_API_KEY || "").trim() || env.LILY_API_KEY === "$LILY_GATEWAY_TOKEN") {
      env.LILY_API_KEY = signModelGatewayToken({
        deviceId: input.deviceId,
        licenseId: input.licenseId || "",
        providerId,
        userId: account.userId || "",
        sessionId: account.sessionId || "",
      });
    }
  }
  return configCopy;
}

export async function resolveAccountContextForClientConfig(input, trx) {
  const token = String(input?.accountAccessToken || "").trim();
  if (!token) return null;
  const verified = verifyAccessToken(token);
  if (!verified.ok || verified.deviceId !== input.deviceId) return null;
  const session = await trx
    .selectFrom("user_sessions")
    .select(["id", "user_id", "device_id", "expires_at", "revoked_at"])
    .where("id", "=", verified.sessionId)
    .executeTakeFirst();
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) return null;
  if (session.user_id !== verified.userId || session.device_id !== verified.deviceId) return null;
  return {
    userId: verified.userId,
    sessionId: verified.sessionId,
    deviceId: verified.deviceId,
  };
}

export function clientConfigTtlMs(serverConfig = config) {
  const maxConfigTtlMs = 24 * 60 * 60 * 1000;
  const gatewayTtlMs = Math.max(60, Number(serverConfig.modelGatewayTokenTtlSeconds) || 3600) * 1000;
  const gatewaySafeTtlMs = Math.max(30 * 1000, gatewayTtlMs - 60 * 1000);
  return Math.min(maxConfigTtlMs, gatewaySafeTtlMs);
}
