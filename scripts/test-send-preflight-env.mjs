#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-send-preflight-env-"));
process.env.LILY_USER_DATA_DIR = tempRoot;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tempRoot;
process.env.OPENCODE_BIN = process.execPath;

const state = {
  schemaVersion: 1,
  configVersion: "runtime-env-only",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  effectiveConfig: {
    runtime: {
      env: {
        LILY_API_BASE_URL: "https://lilych.lilywb.cn/llm/deepseek",
        LILY_API_KEY: "runtime-gateway-token",
        LILY_MODEL: "deepseek-v4-pro",
      },
    },
  },
};

fs.writeFileSync(path.join(tempRoot, "remote-config-cache.json"), JSON.stringify({
  config: {
    encrypted: false,
    data: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
  },
}), "utf8");

const ipcUtils = require("../src/main/ipc-utils.js");
const { diagnoseSendBlocker, refreshRemoteConfigForSend } = ipcUtils;
const modelPresets = require("../src/main/model-presets.js");
const remoteConfig = require("../src/main/remote-config.js");

const ctx = {
  sessionManager: {
    findById: () => ({ id: "s1", projectId: "p1" }),
    getActive: () => ({ id: "s1", projectId: "p1" }),
  },
  projectManager: {
    find: () => ({ id: "p1", path: process.cwd() }),
  },
};

assert.equal(diagnoseSendBlocker(ctx, "s1"), null, "remote runtime env API key must satisfy send preflight");

fs.rmSync(path.join(tempRoot, "remote-config-cache.json"), { force: true });
fs.rmSync(path.join(tempRoot, "model-settings.json"), { force: true });
modelPresets.reloadPresets();
remoteConfig.reloadRemoteConfigCache();
assert.equal(
  diagnoseSendBlocker(ctx, "s1")?.error,
  "SERVICE_MODEL_CONFIG_UNAVAILABLE",
  "missing managed config must not be misreported as a user API key problem",
);

const localGateway = modelPresets.saveCustomPreset({
  label: "Local Test Model",
  model: "local-test-model",
  baseUrl: "http://127.0.0.1:8000/v1",
  protocol: "openai",
});
assert.equal(localGateway.ok, true);
modelPresets.reloadPresets();
assert.equal(
  diagnoseSendBlocker(ctx, "s1"),
  null,
  "loopback custom model endpoints may run without an API key",
);

fs.writeFileSync(path.join(tempRoot, "model-settings.json"), JSON.stringify({
  activePresetId: null,
  customPresets: [],
  apiGateway: {
    mode: "custom",
    baseUrl: "https://custom-llm.example.com/v1",
    protocol: "openai",
  },
}, null, 2));
modelPresets.reloadPresets();
assert.equal(
  diagnoseSendBlocker(ctx, "s1")?.error,
  "NO_API_KEY",
  "user custom remote model without a key should still ask for the user's key",
);

const turnOrchestratorSource = fs.readFileSync(path.join(process.cwd(), "src/main/turn-orchestrator.js"), "utf8");
const timeoutMatch = turnOrchestratorSource.match(/MANAGED_MODEL_CONFIG_SEND_TIMEOUT_MS\s*=\s*([0-9_]+)/);
assert(timeoutMatch, "managed model preflight must use a named timeout constant");
assert(
  Number(timeoutMatch[1].replace(/_/g, "")) >= 90_000,
  "first-run managed model config refresh must wait long enough for bootstrap, device registration, license refresh, and slow networks",
);
assert.match(
  turnOrchestratorSource,
  /refreshRemoteConfigForSend\(\{\s*force:\s*true,\s*timeoutMs:\s*MANAGED_MODEL_CONFIG_SEND_TIMEOUT_MS,\s*repairManagedService:\s*true,\s*\}\)/,
  "send preflight must repair managed service state before reporting managed config unavailable",
);
assert.match(
  turnOrchestratorSource,
  /configRefresh\?\.ok[\s\S]*runnerPool\?\.terminateSession\?\.\(session\.id\)/,
  "send preflight must rebuild the current OpenCode runner after managed config repair",
);

const serviceClient = require("../src/main/service-client.js");
const licenseManager = require("../src/main/license-manager.js");
const originalRefreshClientBootstrap = serviceClient.refreshClientBootstrap;
const originalRegisterDevice = serviceClient.registerDevice;
const originalRefreshServerLicense = licenseManager.refreshServerLicense;
const originalRefreshRemoteConfig = remoteConfig.refreshRemoteConfig;
const repairCalls = [];
try {
  serviceClient.refreshClientBootstrap = async () => {
    repairCalls.push("bootstrap");
    return { ok: true };
  };
  serviceClient.registerDevice = async () => {
    repairCalls.push("device");
    return { ok: true };
  };
  licenseManager.refreshServerLicense = async () => {
    repairCalls.push("license");
    return { ok: true };
  };
  remoteConfig.refreshRemoteConfig = async () => {
    repairCalls.push("remote-config");
    return { ok: true };
  };
  const repaired = await refreshRemoteConfigForSend({
    force: true,
    timeoutMs: 1000,
    repairManagedService: true,
  });
  assert.equal(repaired.ok, true, "managed service repair should still return remote config refresh result");
  assert(repairCalls.includes("bootstrap"), "managed service repair must refresh client bootstrap");
  assert(repairCalls.includes("device"), "managed service repair must register the device");
  assert(repairCalls.includes("license"), "managed service repair must refresh server license state");
  assert(repairCalls.includes("remote-config"), "managed service repair must still refresh remote config");
  assert(
    repairCalls.indexOf("device") > repairCalls.indexOf("bootstrap"),
    "device registration must run after bootstrap repair so it uses the recovered service base",
  );
  assert(
    repairCalls.indexOf("license") > repairCalls.indexOf("device"),
    "server license refresh must run after device registration",
  );
  assert(
    repairCalls.indexOf("remote-config") > repairCalls.indexOf("license"),
    "remote config refresh must run after local service state repair",
  );

  repairCalls.length = 0;
  const activationRepair = await refreshRemoteConfigForSend({
    force: true,
    timeoutMs: 1000,
    repairManagedService: true,
    refreshLicense: false,
    reason: "license_activate",
  });
  assert.equal(activationRepair.ok, true, "activation repair should still refresh remote config");
  assert.deepEqual(
    repairCalls,
    ["bootstrap", "device", "remote-config"],
    "license activation config repair must not persist a failed server license refresh as an invalid activation",
  );
} finally {
  serviceClient.refreshClientBootstrap = originalRefreshClientBootstrap;
  serviceClient.registerDevice = originalRegisterDevice;
  licenseManager.refreshServerLicense = originalRefreshServerLicense;
  remoteConfig.refreshRemoteConfig = originalRefreshRemoteConfig;
}

const ipcHandlersSource = fs.readFileSync(path.join(process.cwd(), "src/main/ipc-handlers.js"), "utf8");
assert.match(
  ipcHandlersSource,
  /license:activate[\s\S]*refreshRemoteConfigForSend\(\{[\s\S]*timeoutMs:\s*90_000[\s\S]*repairManagedService:\s*true[\s\S]*refreshLicense:\s*false[\s\S]*reason:\s*"license_activate"/,
  "license activation must prepare managed model config without letting config repair mark the just-activated license invalid",
);
assert.match(
  ipcHandlersSource,
  /modelConfigReady/,
  "license activation should report whether managed model config became ready",
);
assert.match(
  ipcHandlersSource,
  /configRefresh\?\.ok[\s\S]*terminateIdleRunners\(ctx\.runnerPool\)/,
  "license activation must rebuild idle OpenCode runners after managed config becomes ready",
);

const ipcModelsSource = fs.readFileSync(path.join(process.cwd(), "src/main/ipc-models.js"), "utf8");
assert.match(
  ipcModelsSource,
  /models:list[\s\S]*refreshRemoteConfigForSend\(\{[\s\S]*timeoutMs:\s*45_000[\s\S]*repairManagedService:\s*true[\s\S]*reason:\s*"model_settings"/,
  "model settings must use the managed service repair path before listing presets",
);
assert.match(
  ipcModelsSource,
  /configRefresh\?\.ok[\s\S]*terminateIdleRunners\(ctx\.runnerPool\)/,
  "model settings refresh must rebuild idle OpenCode runners after managed config becomes ready",
);

const licenseSettingsSource = fs.readFileSync(path.join(process.cwd(), "src/renderer/modules/license-update-settings.js"), "utf8");
assert.match(
  licenseSettingsSource,
  /modelConfigReady\s*===\s*false[\s\S]*toast\.licenseActivatedModelConfigPending[\s\S]*modelConfigError/,
  "activation UI must show the config refresh failure reason instead of silently claiming complete readiness",
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("send preflight env: ok");
