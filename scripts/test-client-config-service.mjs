#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildEnvManagedClientConfig,
  DEFAULT_EFFECTIVE_CONFIG,
  clientConfigTtlMs,
  deepMerge,
  decideConfigProfileUpsert,
  decideEnvManagedConfigProfileWrite,
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

assert.deepEqual(
  decideEnvManagedConfigProfileWrite({
    hasEffectiveConfig: true,
    profileExists: true,
    anyProfileExists: true,
    deleted: true,
  }),
  { action: "update" },
  "existing env-managed profile should still refresh when it exists",
);
assert.deepEqual(
  decideEnvManagedConfigProfileWrite({
    hasEffectiveConfig: true,
    profileExists: false,
    anyProfileExists: true,
    deleted: false,
  }),
  { action: "skip", reason: "existing_profiles_without_seed" },
  "missing env-managed profile in a configured DB should not be recreated",
);
assert.deepEqual(
  decideEnvManagedConfigProfileWrite({
    hasEffectiveConfig: true,
    profileExists: false,
    anyProfileExists: false,
    deleted: true,
  }),
  { action: "skip", reason: "deleted_by_admin" },
  "admin-deleted env-managed profile should stay deleted even when all profiles are gone",
);
assert.deepEqual(
  decideEnvManagedConfigProfileWrite({
    hasEffectiveConfig: true,
    profileExists: false,
    anyProfileExists: false,
    deleted: false,
  }),
  { action: "create" },
  "fresh empty DB should still get the first default profile",
);
assert.deepEqual(
  decideConfigProfileUpsert({ profileExists: false, deleted: true }),
  { ok: true },
  "admin saves must be allowed to intentionally recreate a deleted config profile id",
);
assert.deepEqual(
  decideConfigProfileUpsert({ profileExists: true, deleted: true }),
  { ok: true },
  "existing config profiles remain editable even if their id was previously tombstoned",
);
assert.deepEqual(
  decideConfigProfileUpsert({ profileExists: false, deleted: false }),
  { ok: true },
  "new config profile ids can still be created",
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
assert.equal(
  verifyModelGatewayToken(managedEnv.LILY_API_KEY, "deepseek").licenseId,
  "lic_client_config_test",
  "without an explicit scope override the client-reported licenseId is signed as-is",
);

// The gateway verify path is intentionally lean (signature + expiry only), so a
// token's licenseId is trusted downstream for entitlement scoping. It MUST come
// from the server-validated scope, never the raw client-reported licenseId.
const scopedRuntimeConfig = withGatewayRuntimeConfig(
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
  { deviceId: "dev_client_config_test", licenseId: "lic_stale_from_client" },
  { publicBaseUrl: "https://lily.example.com/", licenseScope: "lic_server_validated" },
);
const scopedToken = verifyModelGatewayToken(
  scopedRuntimeConfig.models.presets[0].env.LILY_API_KEY,
  "deepseek",
);
assert.equal(scopedToken.ok, true);
assert.equal(
  scopedToken.licenseId,
  "lic_server_validated",
  "server-validated licenseScope must override the stale client-reported licenseId",
);

// An empty validated scope (device has no valid binding) must be honored — the
// gateway then treats the token as unlicensed rather than trusting a stale id.
const unscopedRuntimeConfig = withGatewayRuntimeConfig(
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
  { deviceId: "dev_client_config_test", licenseId: "lic_stale_from_client" },
  { publicBaseUrl: "https://lily.example.com/", licenseScope: "" },
);
assert.equal(
  verifyModelGatewayToken(
    unscopedRuntimeConfig.models.presets[0].env.LILY_API_KEY,
    "deepseek",
  ).licenseId,
  "",
  "an empty validated scope must not fall back to the client-reported licenseId",
);

// A downloaded-but-not-logged-in device gets its server-issued trial window
// signed into the gateway token, so the gateway can honor the configured trial.
const trialRuntimeConfig = withGatewayRuntimeConfig(
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
  { deviceId: "dev_trial_config_test", licenseId: "" },
  { publicBaseUrl: "https://lily.example.com/", licenseScope: "", trialEndsAt: "2026-07-11T00:00:00.000Z" },
);
assert.equal(
  verifyModelGatewayToken(
    trialRuntimeConfig.models.presets[0].env.LILY_API_KEY,
    "deepseek",
  ).trialEndsAt,
  "2026-07-11T00:00:00.000Z",
  "the device trial window must be signed into the delivered gateway token",
);

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
      metadata: {
        models: {
          "deepseek-v4-pro[1m]": { contextWindowTokens: 196608, maxOutputTokens: 1024 },
        },
      },
    },
  },
);
assert.equal(deepseekManaged.models.activePresetId, "lily-managed:deepseek:gateway");
assert.equal(deepseekManaged.models.presets[0].env.LILY_GATEWAY_PROVIDER, "deepseek");
assert.equal(deepseekManaged.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "anthropic");
assert.equal(deepseekManaged.models.presets[0].env.LILY_MODEL, "deepseek-v4-pro[1m]");
assert.equal(deepseekManaged.models.presets[0].env.LILY_CONTEXT_WINDOW_TOKENS, "196608");
assert.equal(deepseekManaged.models.presets[0].env.LILY_MAX_OUTPUT_TOKENS, "1024");
assert.equal(
  deepseekManaged.models.presets.find((preset) => preset.env.LILY_MODEL === "deepseek-v4-flash").env.LILY_CONTEXT_WINDOW_TOKENS,
  undefined,
  "per-model limits must not leak to another model under the same provider",
);
assert.equal(deepseekManaged.runtime.env.DASHSCOPE_API_KEY, undefined, "raw DashScope key must NOT be delivered");

// Default-provider drift: the configured default ("deepseek") has no key, so it
// is filtered out of the menu. The delivered default must fall back to the only
// available chat provider (dashscope) — deterministically, and with a single
// ops-visible warning — rather than silently shipping an empty/garbage default.
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
let driftDefault;
try {
  driftDefault = buildEnvManagedClientConfig(
    {
      modelGatewayDefaultProvider: "deepseek",
      modelConfigDeliveryMode: "gateway",
    },
    {
      dashscope: {
        id: "dashscope",
        type: "anthropic",
        baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
        apiKey: "sk-test-dashscope-chat",
        models: ["qwen3-coder-plus"],
      },
    },
  );
} finally {
  console.warn = originalWarn;
}
assert.equal(
  driftDefault.models.activePresetId,
  "lily-managed:dashscope:gateway",
  "when the configured default provider is unavailable the default falls back to an available provider",
);
assert.ok(
  warnings.some((line) => line.includes("deepseek") && line.includes("dashscope")),
  "an unavailable configured default provider must emit an ops-visible warning",
);

const vllmManaged = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "iluvatar-vllm",
    modelConfigDeliveryMode: "gateway",
  },
  {
    "iluvatar-vllm": {
      id: "iluvatar-vllm",
      type: "openai",
      baseUrl: "http://127.0.0.1:18000/v1",
      apiKey: "sk-test-vllm",
      model: "/private/Qwen3-Next-80B-A3B-Instruct",
      models: ["/private/Qwen3-Next-80B-A3B-Instruct"],
    },
  },
);
assert.equal(vllmManaged.models.activePresetId, "lily-managed:iluvatar-vllm:gateway");
assert.equal(vllmManaged.models.presets[0].env.LILY_API_BASE_URL, "/llm/iluvatar-vllm/v1");
assert.equal(vllmManaged.models.presets[0].env.LILY_OPENCODE_BASE_URL, "/llm/iluvatar-vllm/v1");
assert.equal(vllmManaged.models.presets[0].env.LILY_GATEWAY_PROVIDER, "iluvatar-vllm");
assert.equal(vllmManaged.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "openai");
assert.equal(vllmManaged.models.presets[0].env.LILY_OPENCODE_PROVIDER_ID, "lily");
assert.equal(vllmManaged.models.presets[0].env.LILY_OPENCODE_PROVIDER_NPM, "@ai-sdk/openai-compatible");
assert.equal(vllmManaged.models.presets[0].env.LILY_MODEL, "/private/Qwen3-Next-80B-A3B-Instruct");

const qwen36GpuManaged = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "iluvatar-vllm",
    modelConfigDeliveryMode: "gateway",
  },
  {
    "iluvatar-vllm": {
      id: "iluvatar-vllm",
      type: "openai",
      baseUrl: "http://127.0.0.1:18000/v1",
      apiKey: "sk-test-vllm",
      model: "/private/Qwen3.6-27B",
      models: ["/private/Qwen3.6-27B"],
      metadata: {
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
        models: {
          "/private/Qwen3.6-27B": {
            contextWindowTokens: 262144,
            maxModelLen: 262144,
            maxOutputTokens: 32768,
            deploymentProfile: "qwen3.6-27b-256k",
          },
        },
      },
    },
  },
);
assert.equal(qwen36GpuManaged.models.presets[0].env.LILY_CONTEXT_WINDOW_TOKENS, "65536");
assert.equal(qwen36GpuManaged.models.presets[0].env.LILY_MAX_OUTPUT_TOKENS, "4096");

const deepseekOpenAiManaged = buildEnvManagedClientConfig(
  {
    modelGatewayDefaultProvider: "deepseek",
    modelConfigDeliveryMode: "gateway",
  },
  {
    deepseek: {
      id: "deepseek",
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test-deepseek",
      model: "deepseek-v4-pro[1m]",
      models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
      metadata: {
        models: {
          "deepseek-v4-pro[1m]": { contextWindowTokens: 1000000 },
        },
      },
    },
  },
);
assert.equal(deepseekOpenAiManaged.models.activePresetId, "lily-managed:deepseek:gateway");
assert.equal(deepseekOpenAiManaged.models.presets[0].env.LILY_API_BASE_URL, "/llm/deepseek/v1");
assert.equal(deepseekOpenAiManaged.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "openai");
assert.equal(deepseekOpenAiManaged.models.presets[0].env.LILY_MODEL, "deepseek-v4-pro");
assert.equal(deepseekOpenAiManaged.models.presets.length, 2, "DeepSeek OpenAI provider should preserve distinct Pro and Flash models");
assert.equal(
  deepseekOpenAiManaged.models.presets[1].env.LILY_MODEL,
  "deepseek-v4-flash",
  "official Flash model id should survive managed config delivery",
);
assert.equal(deepseekOpenAiManaged.models.presets[0].env.LILY_CONTEXT_WINDOW_TOKENS, "1000000");

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
assert.equal(deepseekDirect.models.activePresetId, "lily-managed:deepseek:direct");
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
  whitelisted.models.presets.every((p) => p.id.startsWith("lily-managed:deepseek:")),
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
  ["lily-managed:deepseek:gateway", "lily-managed:glm:gateway"],
  "empty provider allow-list should expose every configured provider",
);
const allProviders = buildEnvManagedClientConfig(
  { modelGatewayDefaultProvider: "deepseek", modelConfigDeliveryMode: "gateway", defaultModelProviders: ["all"] },
  twoProviders,
);
assert.ok(
  allProviders.models.presets.some((p) => p.id.startsWith("lily-managed:glm:")),
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

const singleDeepseekBaseline = buildEnvManagedClientConfig(
  { modelGatewayDefaultProvider: "deepseek", modelConfigDeliveryMode: "gateway", defaultModelProviders: ["deepseek"] },
  {
    deepseek: {
      id: "deepseek",
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-d",
      models: ["deepseek-v4-pro"],
    },
  },
);
assert.equal(singleDeepseekBaseline.models.activePresetId, "lily-managed:deepseek:gateway");
assert.deepEqual(
  singleDeepseekBaseline.models.presets.map((preset) => preset.env.LILY_MODEL),
  ["deepseek-v4-pro"],
  "single configured server DeepSeek model should produce one client preset",
);
assert.equal(
  deepMerge(singleDeepseekBaseline, { policy: { permissionMode: "default" } }).models.presets.length,
  1,
  "profile overlays that do not mention models must keep the env-managed server model baseline",
);

const publicClientConfigRouteSource = fs.readFileSync(
  new URL("../server/src/routes/public/client-config.js", import.meta.url),
  "utf8",
);
assert.match(
  publicClientConfigRouteSource,
  /baselineEffectiveConfig\s*=\s*[\s\S]*buildEnvManagedClientConfig\(/,
  "public client config must start from the server provider baseline, not empty packaged defaults",
);
assert.match(
  publicClientConfigRouteSource,
  /resolveEffectiveConfig\(input,\s*\{\s*baselineEffectiveConfig\s*\}\)/,
  "public client config must pass the server provider baseline into profile resolution",
);

// Per-scope provider menu expansion: a profile's `models.providers` directive
// becomes that scope's preset menu (replacing the baseline it merged onto).
const scopeProviders = {
  deepseek: { id: "deepseek", type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-d", models: ["deepseek-v4-pro[1m]"] },
  glm: { id: "glm", type: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "sk-g", models: ["glm-4.7", "glm-4.5-air"] },
  qwen: {
    id: "qwen",
    type: "anthropic",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    apiKey: "sk-q",
    models: ["qwen-vl-max", "qwen-plus"],
    metadata: { nativeVision: true },
  },
};
const scopeMerged = {
  // baseline (deepseek-only) that a group profile merged its directive onto
  models: {
    source: "service",
    activePresetId: "lily-managed:deepseek:gateway",
    presets: [{ id: "lily-managed:deepseek:gateway" }],
    providers: ["glm"],
    activeProvider: "glm",
    capabilities: { glm: { vision: true } },
  },
};
const expanded = expandModelProviderMenu(scopeMerged, { providers: scopeProviders, deliveryMode: "gateway" });
assert.ok(expanded.models.presets.every((p) => p.id.startsWith("lily-managed:glm:")), "scope menu should expand to the directive's providers only");
assert.equal(expanded.models.providers, undefined, "directive should be consumed");
assert.ok(expanded.models.activePresetId.startsWith("lily-managed:glm:"), "active should be the directive's activeProvider");
assert.deepEqual(expanded.models.capabilities, { glm: { vision: true } }, "provider capabilities must survive directive expansion");
assert.ok(expanded.models.presets.every((p) => p.capabilities?.vision === true), "expanded presets must carry native vision to the client router");

const metadataVisionExpanded = expandModelProviderMenu(
  { models: { source: "service", providers: ["qwen"], activeProvider: "qwen" } },
  { providers: scopeProviders, deliveryMode: "gateway" },
);
assert.ok(
  metadataVisionExpanded.models.presets.every((p) => p.capabilities?.vision === true),
  "provider metadata nativeVision must become preset capabilities.vision",
);

const staleFalseVisionExpanded = expandModelProviderMenu(
  { models: { source: "service", providers: ["qwen"], activeProvider: "qwen", capabilities: { qwen: { vision: false } } } },
  { providers: scopeProviders, deliveryMode: "gateway" },
);
assert.ok(
  staleFalseVisionExpanded.models.presets.every((p) => p.capabilities?.vision === true),
  "stale config-profile vision:false must not override provider metadata nativeVision",
);

const defaultGatewayExpanded = expandModelProviderMenu(
  { models: { source: "service", activePresetId: "lily-managed:deepseek:gateway", presets: [{ id: "lily-managed:deepseek:gateway" }], providers: ["deepseek"] } },
  { providers: scopeProviders },
);
assert.equal(
  defaultGatewayExpanded.models.activePresetId,
  "lily-managed:deepseek:gateway",
  "provider directives must fail safe to gateway when caller does not pass deliveryMode",
);
assert.equal(defaultGatewayExpanded.models.presets[0].env.LILY_API_KEY, "$LILY_GATEWAY_TOKEN");

const explicitDirectExpanded = expandModelProviderMenu(
  { models: { source: "service", activePresetId: "lily-managed:deepseek:gateway", presets: [{ id: "lily-managed:deepseek:gateway" }], providers: ["deepseek"] } },
  { providers: scopeProviders, deliveryMode: "direct" },
);
assert.equal(explicitDirectExpanded.models.activePresetId, "lily-managed:deepseek:direct");
assert.equal(explicitDirectExpanded.models.presets[0].env.LILY_API_KEY, "sk-d");

// Fail-safe: unresolvable providers → keep the baseline menu, drop the directive.
const unresolved = expandModelProviderMenu(
  { models: { source: "service", activePresetId: "lily-managed:deepseek:gateway", presets: [{ id: "lily-managed:deepseek:gateway" }], providers: ["ghost"] } },
  { providers: scopeProviders, deliveryMode: "gateway" },
);
assert.deepEqual(unresolved.models.presets, [{ id: "lily-managed:deepseek:gateway" }], "unresolvable directive keeps baseline presets");
assert.equal(unresolved.models.providers, undefined);

const openAiDirect = buildEnvManagedClientConfig(
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
assert.equal(openAiDirect.models.activePresetId, "lily-managed:openai:direct");
assert.equal(openAiDirect.models.presets[0].env.LILY_API_BASE_URL, "https://api.openai.example/v1");
assert.equal(openAiDirect.models.presets[0].env.LILY_API_KEY, "sk-test-openai");
assert.equal(openAiDirect.models.presets[0].env.LILY_GATEWAY_PROVIDER, undefined);
assert.equal(openAiDirect.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "openai");

const anthropicDirect = buildEnvManagedClientConfig(
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
assert.equal(anthropicDirect.models.activePresetId, "lily-managed:openai:direct");
assert.equal(anthropicDirect.models.presets[0].env.LILY_OPENCODE_PROTOCOL, "anthropic");

// --- resolveMediaSelection: per-scope media multi-select + default (backward-compatible) ---
// 1. No config.media (old profile) + providers available -> all available, server default
//    kept; old clients ignore the added `media` field. (No regression.)
{
  const cfg = resolveMediaSelection(
    { runtime: { env: { LILY_IMAGE_PROVIDER: "dashscope", LILY_VIDEO_PROVIDER: "dashscope", LILY_SPEECH_PROVIDER: "dashscope" } } },
    ["dashscope", "volcengine"],
  );
  assert.deepEqual(cfg.media.image.providers, ["dashscope", "volcengine"], "no selection -> all available (image)");
  assert.deepEqual(cfg.media.speech.providers, ["dashscope"], "no selection -> speech keeps the supported DashScope provider");
  assert.equal(cfg.media.image.default, "dashscope", "no selection -> server default preserved");
  assert.equal(cfg.runtime.env.LILY_IMAGE_PROVIDER, "dashscope", "no selection -> env default unchanged (no regression)");
  assert.equal(cfg.runtime.env.LILY_SPEECH_PROVIDER, "dashscope", "no selection -> speech env default unchanged (no regression)");
}
// 2. Explicit multi-select + default -> gated to available, default drives the skill env.
{
  const cfg = resolveMediaSelection(
    {
      media: {
        image: { providers: ["volcengine", "kling", "ghost"], default: "kling" },
        video: { providers: ["dashscope"], default: "dashscope" },
        speech: { providers: ["volcengine", "dashscope"], default: "volcengine" },
      },
      runtime: { env: { LILY_IMAGE_PROVIDER: "dashscope", LILY_VIDEO_PROVIDER: "dashscope", LILY_SPEECH_PROVIDER: "dashscope" } },
    },
    { image: ["dashscope", "volcengine", "kling"], video: ["dashscope", "volcengine", "kling"], speech: ["dashscope"] },
  );
  assert.deepEqual(cfg.media.image.providers, ["volcengine", "kling"], "unavailable 'ghost' is dropped");
  assert.equal(cfg.media.image.default, "kling", "explicit default honored");
  assert.equal(cfg.runtime.env.LILY_IMAGE_PROVIDER, "kling", "resolved default drives the generation skill env");
  assert.deepEqual(cfg.media.speech.providers, ["dashscope"], "speech selection is gated to TTS-capable providers");
  assert.equal(cfg.runtime.env.LILY_SPEECH_PROVIDER, "dashscope", "invalid speech default falls back to supported service default");
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
// 5. Lily GPU is additive: it appears only when the server marks it available.
{
  const cfg = resolveMediaSelection(
    {
      media: { image: { providers: ["lily", "dashscope"], default: "lily" }, video: { providers: ["lily"], default: "lily" } },
      runtime: { env: { LILY_IMAGE_PROVIDER: "dashscope", LILY_VIDEO_PROVIDER: "dashscope" } },
    },
    { image: ["dashscope", "lily"], video: ["dashscope"], speech: [] },
  );
  assert.deepEqual(cfg.media.image.providers, ["lily", "dashscope"], "lily image remains selectable when available");
  assert.equal(cfg.runtime.env.LILY_IMAGE_PROVIDER, "lily", "lily image can drive the image provider env");
  assert.deepEqual(cfg.media.video.providers, ["dashscope"], "lily video is dropped when no video endpoint is available");
  assert.equal(cfg.runtime.env.LILY_VIDEO_PROVIDER, "dashscope", "video falls back to the available server default");
}

console.log("client-config-service: ok");
