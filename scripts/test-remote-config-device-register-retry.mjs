#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-remote-config-register-retry-"));
process.env.LILY_USER_DATA_DIR = tempRoot;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tempRoot;

const { stableStringify } = require("../src/main/crypto-signing.js");

function devSignature(payload) {
  return `dev.${crypto.createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}

function fakeGatewayToken() {
  const tokenPayload = Buffer.from(JSON.stringify({
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }), "utf8").toString("base64url");
  return `lilygw.${tokenPayload}.sig`;
}

const retryGatewayToken = fakeGatewayToken();

const payload = {
  schemaVersion: 1,
  configVersion: "device-register-retry",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  effectiveConfig: {
    runtime: {
      env: {
        LILY_API_BASE_URL: "https://lilych.lilywb.cn/llm/deepseek",
        LILY_API_KEY: retryGatewayToken,
        LILY_MODEL: "deepseek-v4-pro",
      },
    },
  },
};

const serviceClient = require("../src/main/service-client.js");
let fetchCalls = 0;
let registerCalls = 0;
const originalFetchClientConfig = serviceClient.fetchClientConfig;
const originalRegisterDevice = serviceClient.registerDevice;

serviceClient.fetchClientConfig = async () => {
  fetchCalls += 1;
  if (fetchCalls === 1) return { ok: false, error: "DEVICE_KEY_NOT_REGISTERED", status: 401 };
  return {
    ok: true,
    json: {
      ok: true,
      ...payload,
      deviceId: "dev_retry",
      appliedProfileIds: ["lily-default-runtime"],
      signature: devSignature(payload),
    },
  };
};

serviceClient.registerDevice = async () => {
  registerCalls += 1;
  return { ok: true, json: { ok: true, trial: { enabled: true, valid: true } } };
};

const remoteConfig = require("../src/main/remote-config.js");
const result = await remoteConfig.refreshRemoteConfig({ reason: "send_preflight" });

assert.equal(result.ok, true);
assert.equal(fetchCalls, 2, "config fetch should retry once after device registration");
assert.equal(registerCalls, 1, "device should be registered before retrying config fetch");
assert.equal(remoteConfig.getRemoteRuntimeEnvSync().LILY_API_KEY, retryGatewayToken);

serviceClient.fetchClientConfig = originalFetchClientConfig;
serviceClient.registerDevice = originalRegisterDevice;
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("remote config device register retry: ok");
