#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildEnvManagedClientConfig,
  DEFAULT_EFFECTIVE_CONFIG,
  clientConfigTtlMs,
  deepMerge,
  expandModelProviderMenu,
  isGatewayBaseUrl,
  parseGatewayProvider,
  rolloutAllows,
  resolveMediaSelection,
  withGatewayRuntimeConfig,
} from "../server/src/services/client-config.js";
import { verifyModelGatewayToken } from "../server/src/services/model-gateway/auth.js";

const merged = deepMerge(DEFAULT_EFFECTIVE_CONFIG, {
  models: {
    activePresetId: "managed",
    presets: [{ id: "managed" }],
  },
  tools: {
    enabledPluginIds: ["weather"],
  },
});

assert.equal(DEFAULT_EFFECTIVE_CONFIG.models.activePresetId, "", "deepMerge must not mutate packaged defaults");
assert.equal(
  DEFAULT_EFFECTIVE_CONFIG.tools.pluginRegistryUrl,
  "/api/skills/registry",
  "packaged defaults must use the server-managed skill package registry",
);
assert.deepEqual(DEFAULT_EFFECTIVE_CONFIG.tools.enabledPluginIds, [], "deepMerge must preserve default arrays");
assert.equal(DEFAULT_EFFECTIVE_CONFIG.taskIntelligence.enabled, true);
assert.equal(DEFAULT_EFFECTIVE_CONFIG.taskIntelligence.version, "server-default");
assert.equal(merged.models.activePresetId, "managed");
assert.deepEqual(merged.tools.enabledPluginIds, ["weather"]);

const taskIntelligenceMerged = deepMerge(DEFAULT_EFFECTIVE_CONFIG, {
  taskIntelligence: {
    version: "ops-2026-06",
    categories: {
      ops: {
        terms: ["巡检"],
      },
    },
    workspaceProfiles: [
      {
        id: "ops-workspace",
        markerFiles: ["ops.yaml"],
      },
    ],
    workspaceSignals: [
      {
        id: "ops-signal",
        markerFiles: ["ops.yaml"],
      },
    ],
    verificationStrategies: {
      server_change: ["ops audit"],
    },
  },
});
assert.equal(taskIntelligenceMerged.taskIntelligence.version, "ops-2026-06");
assert.deepEqual(taskIntelligenceMerged.taskIntelligence.categories.ops.terms, ["巡检"]);
assert.equal(taskIntelligenceMerged.taskIntelligence.workspaceProfiles[0].id, "ops-workspace");
assert.equal(taskIntelligenceMerged.taskIntelligence.workspaceSignals[0].id, "ops-signal");
assert.deepEqual(taskIntelligenceMerged.taskIntelligence.verificationStrategies.server_change, ["ops audit"]);

assert.equal(rolloutAllows({ id: "blocked", rollout_percent: 0 }, "device-a"), false);
assert.equal(rolloutAllows({ id: "full", rollout_percent: 100 }, "device-a"), true);
assert.equal(
  rolloutAllows({ id: "stable", rollout_percent: 37 }, "device-a"),
  rolloutAllows({ id: "stable", rollout_percent: 37 }, "device-a"),
  "rollout decision must be deterministic for the same device",
);

assert.equal(isGatewayBaseUrl("/llm/deepseek/v1/messages"), true);
assert.equal(isGatewayBaseUrl("https://api.deepseek.com/anthropic"), false);
assert.equal(parseGatewayProvider("/llm/deepseek/v1/messages"), "deepseek");
assert.equal(parseGatewayProvider("/llm/v1/messages"), "");
assert.equal(parseGatewayProvider("https://gateway.example.com/anything", { LILY_GATEWAY_PROVIDER: "dashscope" }), "dashscope");
assert.equal(
  clientConfigTtlMs({ modelGatewayTokenTtlSeconds: 6 * 60 * 60 }),
  (6 * 60 * 60 - 60) * 1000,
  "signed client config must expire before short-lived gateway token",
);
assert.equal(
  clientConfigTtlMs({ modelGatewayTokenTtlSeconds: 48 * 60 * 60 }),
  24 * 60 * 60 * 1000,
  "client config ttl should still cap at one day",
);

const request = {
  headers: {
    host: "ignored.example.com",
  },
  protocol: "http",
};
const runtimeConfig = withGatewayRuntimeConfig(
  {
    models: {
      presets: [
        {
          id: "managed",
          env: {
            LILY_API_BASE_URL: "/llm/deepseek/v1/messages",
            LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          },
        },
        {
          id: "direct",
          env: {
            LILY_API_BASE_URL: "https://api.deepseek.com/anthropic",
            LILY_API_KEY: "sk-direct",
          },
        },
      ],
    },
  },
  request,
  { deviceId: "dev_client_config_test", licenseId: "lic_client_config_test" },
  { publicBaseUrl: "https://lily.example.com/" },
);

const managedEnv = runtimeConfig.models.presets[0].env;
const directEnv = runtimeConfig.models.presets[1].env;
assert.equal(managedEnv.LILY_API_BASE_URL, "https://lily.example.com/llm/deepseek/v1/messages");
assert.notEqual(managedEnv.LILY_API_KEY, "$LILY_GATEWAY_TOKEN");
assert.equal(managedEnv.LILY_OPENCODE_PROTOCOL, undefined, "legacy managed config should remain untouched");
assert.equal(verifyModelGatewayToken(managedEnv.LILY_API_KEY, "deepseek").ok, true);
assert.equal(directEnv.LILY_API_KEY, "sk-direct", "direct provider keys should not be replaced");

const accountRuntimeConfig = withGatewayRuntimeConfig(
  {
    models: {
      presets: [
        {
          id: "managed",
          env: {
            LILY_API_BASE_URL: "/llm/deepseek/v1/messages",
            LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          },
        },
      ],
    },
  },
  request,
  { deviceId: "dev_client_config_test", licenseId: "" },
  {
    publicBaseUrl: "https://lily.example.com/",
    account: { userId: "usr_client_config_test", sessionId: "sess_client_config_test" },
  },
);
const accountToken = verifyModelGatewayToken(accountRuntimeConfig.models.presets[0].env.LILY_API_KEY, "deepseek");
assert.equal(accountToken.ok, true);
assert.equal(accountToken.userId, "usr_client_config_test", "account gateway token must carry user id for wallet debit");
assert.equal(accountToken.sessionId, "sess_client_config_test", "account gateway token must carry session id for audit");

const regionalRuntimeConfig = withGatewayRuntimeConfig(
  {
    models: {
      presets: [
        {
          id: "managed",
          env: {
            LILY_API_BASE_URL: "/llm/deepseek",
            LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          },
        },
      ],
    },
    runtime: { env: {} },
  },
  { headers: { host: "lilyxinjiapo.lilywb.cn", "x-forwarded-proto": "https" }, protocol: "http" },
  { deviceId: "dev_regional_config_test", licenseId: "lic_regional_config_test" },
  {
    publicBaseUrl: "https://www.lilywb.cn",
    policyBaseUrl: "https://lilyxinjiapo.lilywb.cn",
    mediaDeliveryMode: "gateway",
  },
);
assert.equal(
  regionalRuntimeConfig.models.presets[0].env.LILY_API_BASE_URL,
  "https://lilyxinjiapo.lilywb.cn/llm/deepseek",
  "regional policy base must override the generic public website base for model gateway URLs",
);

const mediaOnly = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "deepseek",
    dashscopeApiKey: "sk-test-dashscope",
    dashscopeImageModel: "qwen-image-2.0-pro",
    dashscopeVideoModel: "wan2.7-t2v",
    dashscopeTtsModel: "cosyvoice-v3-flash",
    dashscopeTtsVoice: "longanyang",
    dashscopeImageEndpoint: "https://dashscope.example.test/image",
    dashscopeVideoEndpoint: "",
    dashscopeTtsEndpoint: "",
  },
  {},
);
assert.equal(mediaOnly.models, undefined, "DashScope media key must not create a Qwen chat preset");
assert.equal(
  mediaOnly.runtime.env.DASHSCOPE_API_KEY,
  undefined,
  "raw DashScope key must NOT be delivered — a token + proxy base URLs are injected at request time",
);
assert.equal(mediaOnly.runtime.env.VISION_MODEL, "qwen-vl-max");
assert.equal(mediaOnly.runtime.env.DASHSCOPE_IMAGE_MODEL, "qwen-image-2.0-pro");
assert.equal(mediaOnly.runtime.env.DASHSCOPE_IMAGE_ENDPOINT, "https://dashscope.example.test/image");
assert.equal(
  mediaOnly.runtime.env.DASHSCOPE_BASE_URL,
  undefined,
  "media config must not inherit Claude-compatible DashScope base URL",
);

const legacyVisionModel = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "deepseek",
    dashscopeApiKey: "sk-test-dashscope",
    visionModel: "qwen3.7-plus",
  },
  {},
);
assert.equal(
  legacyVisionModel.runtime.env.VISION_MODEL,
  "qwen-vl-max",
  "legacy vision model aliases must route to Qwen-VL-Max",
);

const deepseekManaged = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "deepseek",
    modelConfigDeliveryMode: "gateway",
    dashscopeApiKey: "sk-test-dashscope",
  },
  {
    deepseek: {
      id: "deepseek",
      type: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-test-deepseek",
      models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
    },
  },
);
assert.equal(deepseekManaged.models.activePresetId, "deepseek-gateway");
assert.equal(deepseekManaged.models.presets[0].env.LILY_GATEWAY_PROVIDER, "deepseek");
assert.equal(deepseekManaged.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "anthropic");
assert.equal(deepseekManaged.models.presets[0].env.LILY_MODEL, "deepseek-v4-pro[1m]");
assert.equal(deepseekManaged.runtime.env.DASHSCOPE_API_KEY, undefined, "raw DashScope key must NOT be delivered");

const deepseekDirect = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "deepseek",
    modelConfigDeliveryMode: "direct",
    dashscopeApiKey: "sk-test-dashscope",
  },
  {
    deepseek: {
      id: "deepseek",
      type: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-test-deepseek",
      models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
    },
  },
);
assert.equal(deepseekDirect.models.activePresetId, "deepseek-direct");
assert.equal(deepseekDirect.models.presets[0].env.LILY_API_BASE_URL, "https://api.deepseek.com/anthropic");
assert.equal(deepseekDirect.models.presets[0].env.LILY_API_KEY, "sk-test-deepseek");
assert.equal(deepseekDirect.models.presets[0].env.LILY_GATEWAY_PROVIDER, undefined);
assert.equal(deepseekDirect.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "anthropic");
assert.equal(deepseekDirect.models.presets[0].env.LILY_MODEL, "deepseek-v4-pro[1m]");
assert.equal(deepseekDirect.models.presets[0].env.LILY_MODEL_HAIKU, "deepseek-v4-pro[1m]");
assert.equal(deepseekDirect.models.presets[0].env.LILY_SUBAGENT_MODEL, "deepseek-v4-pro[1m]");

// Global default allow-list: baseline limited to listed providers even when
// more are configured. Empty allow-list means no narrowing; "all" is an
// explicit no-narrowing alias. Invalid explicit lists fail closed.
const twoProviders = {
  deepseek: { id: "deepseek", type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-d", models: ["deepseek-v4-pro[1m]"] },
  glm: { id: "glm", type: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "sk-g", models: ["glm-4.7"] },
};
const whitelisted = buildEnvManagedClientConfig(
  { modelGatewayDefaultProvider: "deepseek", modelConfigDeliveryMode: "gateway", defaultModelProviders: ["deepseek"] },
  twoProviders,
);
assert.ok(
  whitelisted.models.presets.every((p) => p.id.startsWith("deepseek-")),
  "whitelist should limit the baseline to deepseek only",
);
assert.ok(
  !whitelisted.models.catalog?.length || whitelisted.models.catalog.every((p) => p.id === "deepseek"),
  "whitelist should limit the BYOK model catalog to deepseek only",
);
const noWhitelist = buildEnvManagedClientConfig(
  { modelGatewayDefaultProvider: "deepseek", modelConfigDeliveryMode: "gateway", defaultModelProviders: [] },
  twoProviders,
);
assert.deepEqual(
  noWhitelist.models.presets.map((p) => p.id).sort(),
  ["deepseek-gateway", "glm-gateway"],
  "empty provider allow-list should expose every configured provider",
);
const allProviders = buildEnvManagedClientConfig(
  { modelGatewayDefaultProvider: "deepseek", modelConfigDeliveryMode: "gateway", defaultModelProviders: ["all"] },
  twoProviders,
);
assert.ok(
  allProviders.models.presets.some((p) => p.id.startsWith("glm-")),
  "all should expose every configured provider",
);
const invalidWhitelist = buildEnvManagedClientConfig(
  { modelGatewayDefaultProvider: "deepseek", modelConfigDeliveryMode: "gateway", defaultModelProviders: ["missing-provider"] },
  twoProviders,
);
assert.ok(
  !invalidWhitelist?.models?.presets?.length,
  "explicit unmatched provider allow-list must not leak another provider",
);

// Per-scope provider menu expansion: a profile's `models.providers` directive
// becomes that scope's preset menu (replacing the baseline it merged onto).
const scopeProviders = {
  deepseek: { id: "deepseek", type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-d", models: ["deepseek-v4-pro[1m]"] },
  glm: { id: "glm", type: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "sk-g", models: ["glm-4.7", "glm-4.5-air"] },
};
const scopeMerged = {
  // baseline (deepseek-only) that a group profile merged its directive onto
  models: { source: "service", activePresetId: "deepseek-gateway", presets: [{ id: "deepseek-gateway" }], providers: ["glm"], activeProvider: "glm" },
};
const expanded = expandModelProviderMenu(scopeMerged, { providers: scopeProviders, deliveryMode: "gateway" });
assert.ok(expanded.models.presets.every((p) => p.id.startsWith("glm-")), "scope menu should expand to the directive's providers only");
assert.equal(expanded.models.providers, undefined, "directive should be consumed");
assert.ok(expanded.models.activePresetId.startsWith("glm-"), "active should be the directive's activeProvider");

const defaultGatewayExpanded = expandModelProviderMenu(
  { models: { source: "service", activePresetId: "deepseek-gateway", presets: [{ id: "deepseek-gateway" }], providers: ["deepseek"] } },
  { providers: scopeProviders },
);
assert.equal(
  defaultGatewayExpanded.models.activePresetId,
  "deepseek-gateway",
  "provider directives must fail safe to gateway when caller does not pass deliveryMode",
);
assert.equal(defaultGatewayExpanded.models.presets[0].env.LILY_API_KEY, "$LILY_GATEWAY_TOKEN");

const explicitDirectExpanded = expandModelProviderMenu(
  { models: { source: "service", activePresetId: "deepseek-gateway", presets: [{ id: "deepseek-gateway" }], providers: ["deepseek"] } },
  { providers: scopeProviders, deliveryMode: "direct" },
);
assert.equal(explicitDirectExpanded.models.activePresetId, "deepseek-direct");
assert.equal(explicitDirectExpanded.models.presets[0].env.LILY_API_KEY, "sk-d");

// Fail-safe: unresolvable providers → keep the baseline menu, drop the directive.
const unresolved = expandModelProviderMenu(
  { models: { source: "service", activePresetId: "deepseek-gateway", presets: [{ id: "deepseek-gateway" }], providers: ["ghost"] } },
  { providers: scopeProviders, deliveryMode: "gateway" },
);
assert.deepEqual(unresolved.models.presets, [{ id: "deepseek-gateway" }], "unresolvable directive keeps baseline presets");
assert.equal(unresolved.models.providers, undefined);

const openAiDirectFallback = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "openai",
    modelConfigDeliveryMode: "direct",
  },
  {
    openai: {
      id: "openai",
      type: "openai",
      baseUrl: "https://api.openai.example/v1",
      apiKey: "sk-test-openai",
      models: ["gpt-test"],
    },
  },
);
assert.equal(openAiDirectFallback.models.activePresetId, "openai-gateway");
assert.equal(openAiDirectFallback.models.presets[0].env.LILY_GATEWAY_PROVIDER, "openai");
assert.equal(openAiDirectFallback.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "anthropic");

const openAiDirect = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "openai",
    modelConfigDeliveryMode: "direct",
  },
  {
    openai: {
      id: "openai",
      type: "anthropic",
      baseUrl: "https://openai-anthropic.example",
      apiKey: "sk-test-openai",
      models: ["gpt-test"],
    },
  },
);
assert.equal(openAiDirect.models.activePresetId, "openai-direct");
assert.equal(openAiDirect.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "anthropic");

// --- resolveMediaSelection: per-scope media multi-select + default (backward-compatible) ---
// 1. No config.media (old profile) + providers available -> all available, server default
//    kept; old clients ignore the added `media` field. (No regression.)
{
  const cfg = resolveMediaSelection(
    { runtime: { env: { LILY_IMAGE_PROVIDER: "dashscope", LILY_VIDEO_PROVIDER: "dashscope" } } },
    ["dashscope", "volcengine"],
  );
  assert.deepEqual(cfg.media.image.providers, ["dashscope", "volcengine"], "no selection -> all available (image)");
  assert.equal(cfg.media.image.default, "dashscope", "no selection -> server default preserved");
  assert.equal(cfg.runtime.env.LILY_IMAGE_PROVIDER, "dashscope", "no selection -> env default unchanged (no regression)");
}
// 2. Explicit multi-select + default -> gated to available, default drives the skill env.
{
  const cfg = resolveMediaSelection(
    {
      media: { image: { providers: ["volcengine", "kling", "ghost"], default: "kling" }, video: { providers: ["dashscope"], default: "dashscope" } },
      runtime: { env: { LILY_IMAGE_PROVIDER: "dashscope", LILY_VIDEO_PROVIDER: "dashscope" } },
    },
    ["dashscope", "volcengine", "kling"],
  );
  assert.deepEqual(cfg.media.image.providers, ["volcengine", "kling"], "unavailable 'ghost' is dropped");
  assert.equal(cfg.media.image.default, "kling", "explicit default honored");
  assert.equal(cfg.runtime.env.LILY_IMAGE_PROVIDER, "kling", "resolved default drives the generation skill env");
}
// 3. Default not in the available set -> falls back to server default, else first.
{
  const cfg = resolveMediaSelection(
    { media: { image: { providers: ["volcengine"], default: "kling" } }, runtime: { env: { LILY_IMAGE_PROVIDER: "dashscope" } } },
    ["dashscope", "volcengine"],
  );
  assert.equal(cfg.media.image.default, "volcengine", "invalid default -> only allowed one");
}
// 4. No providers available at all -> leave config untouched (today's behavior).
{
  const cfg = resolveMediaSelection({ media: { image: { providers: ["dashscope"], default: "dashscope" } } }, []);
  assert.equal(cfg.media.image.providers[0], "dashscope", "no availability -> config left as-is (no media resolution)");
  assert.ok(!("video" in cfg.media), "no availability -> untouched");
}

console.log("client-config-service: ok");
