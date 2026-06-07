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
});
if (!saved.ok) throw new Error(`saveCustomPreset failed: ${saved.error}`);

const gateway = modelPresets.setApiGateway({
  mode: "custom",
  baseUrl: "https://gateway.example.com",
  apiKey: gatewayKey,
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
if (env.LILY_API_KEY !== gatewayKey) {
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
const customSwitch = modelPresets.setActivePreset(remoteCustom.preset.id);
if (!customSwitch.ok) {
  throw new Error(`custom preset should be selectable under remote catalog: ${customSwitch.error}`);
}
const remoteCustomEnv = modelPresets.getUserApiEnv();
if (
  remoteCustomEnv.LILY_API_BASE_URL !== "https://custom-remote.example.com" ||
  remoteCustomEnv.LILY_API_KEY !== "sk-remote-compatible-secret-123456"
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
