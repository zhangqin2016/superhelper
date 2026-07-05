#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-model-direct-policy-"));

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
      getVersion: () => "0.1.0",
      isPackaged: false,
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
  },
};

fs.writeFileSync(
  path.join(tmp, "client-bootstrap-policy.json"),
  JSON.stringify({
    ok: true,
    schemaVersion: 1,
    source: "remote",
    region: "uae",
    apiBaseUrl: "https://lilyxinjiapo.lilywb.cn",
    gatewayBaseUrl: "https://lilyxinjiapo.lilywb.cn",
    modelGatewayBaseUrl: "https://lilyxinjiapo.lilywb.cn/llm",
    features: {
      accountLogin: false,
      purchase: false,
      licenseActivation: true,
      usage: true,
      modelDirect: false,
      account: false,
      billing: false,
    },
    routing: { modelMode: "gateway" },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }),
  "utf8",
);

const remoteConfigState = {
  schemaVersion: 1,
  configVersion: "test-managed-model-direct-disabled",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  effectiveConfig: {
    models: {
      activePresetId: "managed",
      presets: [
        {
          id: "managed",
          label: "Managed Model",
          env: {
            LILY_API_BASE_URL: "https://lilyxinjiapo.lilywb.cn/llm/deepseek/v1",
            LILY_API_KEY: "lilygw.test-token",
            LILY_GATEWAY_PROVIDER: "deepseek",
            LILY_OPENCODE_PROTOCOL: "openai",
            LILY_MODEL: "deepseek-v4-pro",
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
      encrypted: false,
      data: Buffer.from(JSON.stringify(remoteConfigState), "utf8").toString("base64"),
    },
    updatedAt: new Date().toISOString(),
  }),
  "utf8",
);

fs.writeFileSync(
  path.join(tmp, "model-settings.json"),
  JSON.stringify({
    activePresetId: "custom-old-direct",
    customPresets: [
      {
        id: "custom-old-direct",
        label: "Old Direct",
        model: "old-direct-model",
        baseUrl: "https://custom.example.com/v1",
        apiKey: "sk-custom-secret-123456",
      },
    ],
    apiGateway: {
      mode: "custom",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-gateway-secret-123456",
    },
  }),
  "utf8",
);

const modelPresets = require(path.join(__dirname, "../src/main/model-presets.js"));

const list = modelPresets.listPresetsPublic();
assert.equal(list.modelDirectAllowed, false);
assert.equal(list.managedByService, true);
assert.equal(list.activePresetId, "managed", "old custom active preset must fall back to service-managed model");
assert.equal(list.presets.some((preset) => preset.custom), false, "direct custom presets are hidden by cloud policy");
assert.deepEqual(modelPresets.getUserApiEnv(), {}, "direct env overrides must be ignored by cloud policy");

const saveCustom = modelPresets.saveCustomPreset({
  label: "Blocked Custom",
  model: "blocked-model",
  baseUrl: "https://blocked.example.com/v1",
  apiKey: "sk-blocked-secret-123456",
});
assert.equal(saveCustom.ok, false);
assert.equal(saveCustom.error, "MODEL_DIRECT_DISABLED");

const customGateway = modelPresets.setApiGateway({
  mode: "custom",
  baseUrl: "https://blocked-gateway.example.com/v1",
  apiKey: "sk-blocked-gateway-123456",
});
assert.equal(customGateway.ok, false);
assert.equal(customGateway.error, "MODEL_DIRECT_DISABLED");

const resetGateway = modelPresets.setApiGateway({ mode: "builtin" });
assert.equal(resetGateway.ok, true, "users can still clear stale direct settings");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("model-direct-policy: ok");
