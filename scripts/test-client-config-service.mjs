#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildEnvManagedClientConfig,
  DEFAULT_EFFECTIVE_CONFIG,
  clientConfigTtlMs,
  deepMerge,
  isGatewayBaseUrl,
  parseGatewayProvider,
  rolloutAllows,
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
assert.equal(verifyModelGatewayToken(managedEnv.LILY_API_KEY, "deepseek").ok, true);
assert.equal(directEnv.LILY_API_KEY, "sk-direct", "direct provider keys should not be replaced");

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
assert.equal(mediaOnly.runtime.env.VISION_MODEL, "qwen3-vl-plus");
assert.equal(mediaOnly.runtime.env.DASHSCOPE_IMAGE_MODEL, "qwen-image-2.0-pro");
assert.equal(mediaOnly.runtime.env.DASHSCOPE_IMAGE_ENDPOINT, "https://dashscope.example.test/image");
assert.equal(
  mediaOnly.runtime.env.DASHSCOPE_BASE_URL,
  undefined,
  "media config must not inherit Claude-compatible DashScope base URL",
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
assert.equal(deepseekDirect.models.presets[0].env.LILY_MODEL, "deepseek-v4-pro[1m]");
assert.equal(deepseekDirect.models.presets[0].env.LILY_MODEL_HAIKU, "deepseek-v4-flash");

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

console.log("client-config-service: ok");
