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

const { diagnoseSendBlocker } = require("../src/main/ipc-utils.js");
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

const localGateway = modelPresets.setApiGateway({
  mode: "custom",
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

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("send preflight env: ok");
