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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("model-settings-secret-storage: ok");
