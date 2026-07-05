#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-model-secrets-"));

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        if (name === "documents") return tmp;
        return tmp;
      },
      isPackaged: false,
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (buffer) => Buffer.from(buffer).toString("utf8").replace(/^protected:/, ""),
    },
  },
};

const modelPresets = require(path.join(__dirname, "../src/main/model-presets.js"));
const key = "sk-test-secret-123456";
const gatewayKey = "sk-gateway-secret-123456";

const saved = modelPresets.saveCustomPreset({
  label: "Secret Model",
  model: "secret-model",
  baseUrl: "https://llm.example.com",
  apiKey: key,
  protocol: "openai",
  tlsSkipVerify: true,
});
if (!saved.ok) throw new Error(`saveCustomPreset failed: ${saved.error}`);
if (!saved.preset.tlsSkipVerify) {
  throw new Error("custom preset should expose TLS skip when saved for its own API URL");
}
const missingCustomUrl = modelPresets.saveCustomPreset({
  label: "Missing URL",
  model: "missing-url-model",
  apiKey: "sk-missing-url-123456",
});
if (missingCustomUrl.ok || missingCustomUrl.error !== "INVALID_BASE_URL") {
  throw new Error(`custom presets must require their own API URL: ${JSON.stringify(missingCustomUrl)}`);
}
const missingCustomKey = modelPresets.saveCustomPreset({
  label: "Missing Key",
  model: "missing-key-model",
  baseUrl: "https://missing-key.example.com/v1",
});
if (missingCustomKey.ok || missingCustomKey.error !== "INVALID_API_KEY") {
  throw new Error(`custom presets must require their own API key: ${JSON.stringify(missingCustomKey)}`);
}
const localNoKey = modelPresets.saveCustomPreset({
  label: "Local Qwen",
  model: "/private/Qwen3-Next-80B-A3B-Instruct",
  baseUrl: "http://127.0.0.1:8000/v1",
  protocol: "openai",
});
if (!localNoKey.ok) {
  throw new Error(`loopback OpenAI-compatible custom presets should allow no API key: ${localNoKey.error}`);
}
modelPresets.setActivePreset(localNoKey.preset.id);
const localEnv = modelPresets.getUserApiEnv();
if (
  localEnv.LILY_API_BASE_URL !== "http://127.0.0.1:8000/v1" ||
  localEnv.LILY_API_KEY ||
  localEnv.LILY_OPENCODE_PROTOCOL !== "openai"
) {
  throw new Error(`loopback custom preset env should normalize URL and force openai protocol: ${JSON.stringify(localEnv)}`);
}
const fullEndpoint = modelPresets.saveCustomPreset({
  label: "Full Endpoint",
  model: "endpoint-model",
  baseUrl: "http://127.0.0.1:8000/v1/chat/completions",
  protocol: "openai",
});
if (fullEndpoint.ok || fullEndpoint.error !== "INVALID_BASE_URL") {
  throw new Error(`custom model base URL must reject full chat/completions endpoints instead of silently rewriting: ${JSON.stringify(fullEndpoint)}`);
}
const explicitAnthropic = modelPresets.saveCustomPreset({
  label: "Explicit Anthropic",
  model: "claude-custom",
  baseUrl: "https://proxy.example.com/custom",
  apiKey: "sk-explicit-anthropic-123456",
  protocol: "anthropic",
});
if (!explicitAnthropic.ok) throw new Error(`explicit anthropic custom preset should save: ${explicitAnthropic.error}`);
modelPresets.setActivePreset(explicitAnthropic.preset.id);
const explicitAnthropicEnv = modelPresets.getUserApiEnv();
if (explicitAnthropicEnv.LILY_OPENCODE_PROTOCOL !== "anthropic") {
  throw new Error(`custom preset protocol must come from explicit user choice, not URL guessing: ${JSON.stringify(explicitAnthropicEnv)}`);
}
const { resolveOpencodeModelConfig } = require(path.join(__dirname, "../src/main/runtime/opencode-model-config.js"));
const localOpenCode = resolveOpencodeModelConfig({
  ...localNoKey.preset.env,
  ...localEnv,
});
if (
  !localOpenCode.ok ||
  localOpenCode.protocol !== "openai" ||
  localOpenCode.baseUrl !== "http://127.0.0.1:8000/v1" ||
  localOpenCode.model?.modelID !== "/private/Qwen3-Next-80B-A3B-Instruct"
) {
  throw new Error(`loopback custom preset should build OpenAI-compatible OpenCode config: ${JSON.stringify(localOpenCode)}`);
}
modelPresets.setActivePreset(saved.preset.id);
modelPresets.setActivePreset("pro");

const gateway = modelPresets.setApiGateway({
  mode: "custom",
  baseUrl: "https://gateway.example.com",
  apiKey: gatewayKey,
  protocol: "anthropic",
});
if (!gateway.ok) throw new Error(`setApiGateway failed: ${gateway.error}`);

const settingsPath = path.join(tmp, "model-settings.json");
const raw = fs.readFileSync(settingsPath, "utf8");
if (raw.includes(key) || raw.includes(gatewayKey)) {
  throw new Error("model settings file must not contain plaintext API keys");
}
if (!raw.includes("apiKeyProtected")) {
  throw new Error("model settings file should store protected API key records");
}

modelPresets.reloadPresets();
const env = modelPresets.getUserApiEnv();
if (env.LILY_API_KEY !== gatewayKey || env.LILY_OPENCODE_PROTOCOL !== "anthropic") {
  throw new Error(`gateway key did not decrypt correctly: ${JSON.stringify(env)}`);
}

fs.writeFileSync(
  settingsPath,
  JSON.stringify({
    activePresetId: null,
    customPresets: [],
    apiGateway: {
      mode: "custom",
      baseUrl: "https://legacy.example.com",
      apiKey: "sk-legacy-secret-123456",
    },
  }),
  "utf8",
);
modelPresets.reloadPresets();
const migratedEnv = modelPresets.getUserApiEnv();
if (migratedEnv.LILY_API_KEY !== "sk-legacy-secret-123456") {
  throw new Error("legacy plaintext API key should still load before migration");
}
const migratedRaw = fs.readFileSync(settingsPath, "utf8");
if (migratedRaw.includes("sk-legacy-secret-123456")) {
  throw new Error("legacy plaintext API key should be migrated after load");
}

const remoteConfigState = {
  schemaVersion: 1,
  configVersion: "test-managed",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  effectiveConfig: {
    models: {
      activePresetId: "managed",
      presets: [
        {
          id: "managed",
          label: "Managed Model",
          env: {
            LILY_API_BASE_URL: "/llm/deepseek",
            LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
            LILY_MODEL: "managed-model",
          },
        },
      ],
    },
    runtime: {
      env: {
        VISION_API_KEY: "remote-vision-key-123456",
        IQS_API_KEY: "remote-iqs-key-123456",
      },
    },
  },
};
fs.writeFileSync(
  path.join(tmp, "remote-config-cache.json"),
  JSON.stringify({
    config: {
      encrypted: true,
      data: Buffer.from(`protected:${JSON.stringify(remoteConfigState)}`, "utf8").toString("base64"),
    },
    updatedAt: new Date().toISOString(),
  }),
  "utf8",
);
modelPresets.reloadPresets();
const remoteCustom = modelPresets.saveCustomPreset({
  label: "Remote Compatible Custom",
  model: "remote-compatible-model",
  baseUrl: "https://custom-remote.example.com",
  apiKey: "sk-remote-compatible-secret-123456",
  protocol: "openai",
  tlsSkipVerify: true,
});
if (!remoteCustom.ok) {
  throw new Error(`custom preset should still be saveable under remote catalog: ${remoteCustom.error}`);
}
const managedList = modelPresets.listPresetsPublic();
if (!managedList.managedByService) {
  throw new Error("remote-managed model catalog should be marked as service managed");
}
if (!managedList.presets.some((preset) => preset.id === "managed")) {
  throw new Error("remote-managed model catalog should expose service presets");
}
if (!managedList.presets.some((preset) => preset.custom)) {
  throw new Error("remote-managed model catalog must keep local custom presets available");
}
if (modelPresets.getUserApiEnv().LILY_API_KEY) {
  throw new Error("selected service preset must not be overridden by local API gateway keys");
}
const officialDirectState = {
  schemaVersion: 1,
  configVersion: "test-direct",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  effectiveConfig: {
    models: {
      activePresetId: "official-direct",
      presets: [
        {
          id: "official-direct",
          label: "Official Direct",
          env: {
            LILY_API_BASE_URL: "https://official.example.com/v1",
            LILY_API_KEY: "sk-official-secret-123456",
            LILY_MODEL: "official-model",
          },
        },
      ],
    },
  },
};
fs.writeFileSync(
  path.join(tmp, "remote-config-cache.json"),
  JSON.stringify({
    config: {
      encrypted: true,
      data: Buffer.from(`protected:${JSON.stringify(officialDirectState)}`, "utf8").toString("base64"),
    },
    updatedAt: new Date().toISOString(),
  }),
  "utf8",
);
modelPresets.reloadPresets();
const customGateway = modelPresets.setApiGateway({
  mode: "custom",
  baseUrl: "https://wrong-custom.example.com/v1",
  apiKey: "sk-wrong-custom-secret-123456",
  protocol: "openai",
});
if (!customGateway.ok) throw new Error(`setApiGateway for official direct guard failed: ${customGateway.error}`);
modelPresets.reloadPresets();
const autoCleanedList = modelPresets.listPresetsPublic();
if (autoCleanedList.apiGateway.mode !== "builtin" || autoCleanedList.apiGateway.baseUrl) {
  throw new Error(`loading an official preset with its own connection must auto-clear stale custom API: ${JSON.stringify(autoCleanedList.apiGateway)}`);
}
const customGatewayForSwitch = modelPresets.setApiGateway({
  mode: "custom",
  baseUrl: "https://wrong-custom.example.com/v1",
  apiKey: "sk-wrong-custom-secret-123456",
  protocol: "openai",
});
if (!customGatewayForSwitch.ok) throw new Error(`setApiGateway before switch guard failed: ${customGatewayForSwitch.error}`);
const officialSwitch = modelPresets.setActivePreset("official-direct");
if (!officialSwitch.ok) throw new Error(`official direct preset should be selectable: ${officialSwitch.error}`);
const officialList = modelPresets.listPresetsPublic();
if (officialList.apiGateway.mode !== "builtin" || officialList.apiGateway.baseUrl) {
  throw new Error(`selecting an official preset with its own connection must clear custom API override: ${JSON.stringify(officialList.apiGateway)}`);
}
const officialOverrideEnv = modelPresets.getUserApiEnv();
if (Object.keys(officialOverrideEnv).length) {
  throw new Error(`official preset own connection must not be overridden by stale custom API: ${JSON.stringify(officialOverrideEnv)}`);
}
fs.writeFileSync(
  path.join(tmp, "remote-config-cache.json"),
  JSON.stringify({
    config: {
      encrypted: true,
      data: Buffer.from(`protected:${JSON.stringify(remoteConfigState)}`, "utf8").toString("base64"),
    },
    updatedAt: new Date().toISOString(),
  }),
  "utf8",
);
modelPresets.reloadPresets();
const customSwitch = modelPresets.setActivePreset(remoteCustom.preset.id);
if (!customSwitch.ok) {
  throw new Error(`custom preset should be selectable under remote catalog: ${customSwitch.error}`);
}
const remoteCustomEnv = modelPresets.getUserApiEnv();
if (
  remoteCustomEnv.LILY_API_BASE_URL !== "https://custom-remote.example.com" ||
  remoteCustomEnv.LILY_API_KEY !== "sk-remote-compatible-secret-123456" ||
  remoteCustomEnv.LILY_OPENCODE_PROTOCOL !== "openai" ||
  remoteCustomEnv.LILY_TLS_SKIP_VERIFY !== "1"
) {
  throw new Error(`selected custom preset should use local custom API settings: ${JSON.stringify(remoteCustomEnv)}`);
}
const agentSettings = require(path.join(__dirname, "../src/main/agent-settings.js"));
if (agentSettings.resolveSettingsEnvValue("VISION_API_KEY") !== "remote-vision-key-123456") {
  throw new Error("runtime secrets should be resolved from signed remote config first");
}
const searchSettings = require(path.join(__dirname, "../src/main/search-settings.js"));
if (searchSettings.getSearchSpawnEnv().WEBSEARCH_IQS_API_KEY !== "remote-iqs-key-123456") {
  throw new Error("search provider key should be resolved from signed remote config first");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("model-settings-secret-storage: ok");
