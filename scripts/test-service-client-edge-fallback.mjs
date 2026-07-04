#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-service-edge-fallback-"));

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath(name) {
        if (name === "userData") return tmp;
        return os.tmpdir();
      },
      getVersion: () => "0.1.0",
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
  },
};

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
process.env.LILY_CLIENT_REGION = "uae";

const requests = [];
global.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (String(url).startsWith("https://lilyuae.lilywb.cn/")) {
    throw new Error("getaddrinfo ENOTFOUND lilyuae.lilywb.cn");
  }
  if (String(url) === "https://lilych.lilywb.cn/api/client/bootstrap") {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        region: "uae",
        apiBaseUrl: "https://lilyuae.lilywb.cn",
        gatewayBaseUrl: "https://lilyuae.lilywb.cn",
        modelGatewayBaseUrl: "https://lilyuae.lilywb.cn/llm",
        features: {
          accountLogin: false,
          purchase: false,
          licenseActivation: true,
          modelDirect: false,
        },
        routing: { modelMode: "gateway", releaseChannel: "domestic" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    };
  }
  if (String(url).startsWith("https://lilych.lilywb.cn/")) {
    return { ok: true, json: async () => ({ ok: true }) };
  }
  throw new Error(`unexpected URL ${url}`);
};

const {
  getServiceSettings,
  refreshClientBootstrap,
  fetchUsageSummary,
  registerDevice,
  sendSmsCode,
} = require(path.join(__dirname, "../src/main/service-client.js"));

assert.equal(getServiceSettings().apiBaseUrl, "https://lilyuae.lilywb.cn");

await registerDevice();
assert.equal(requests[0]?.url, "https://lilyuae.lilywb.cn/api/devices/register");
assert.equal(requests[1]?.url, "https://lilych.lilywb.cn/api/devices/register");

const sms = await sendSmsCode("+971500000000");
assert.equal(sms.ok, false);
assert.equal(sms.error, "SERVICE_REQUEST_FAILED");
assert.equal(requests[2]?.url, "https://lilyuae.lilywb.cn/api/auth/sms/send");

const usageSummary = await fetchUsageSummary();
assert.equal(usageSummary.ok, true);
assert.equal(requests[3]?.url, "https://lilyuae.lilywb.cn/api/usage/summary");
assert.equal(requests[4]?.url, "https://lilych.lilywb.cn/api/usage/summary");

const bootstrap = await refreshClientBootstrap({ force: true });
assert.equal(bootstrap.ok, true);
assert.equal(bootstrap.region, "uae");
assert.equal(bootstrap.apiBaseUrl, "https://lilych.lilywb.cn");
assert.equal(bootstrap.gatewayBaseUrl, "https://lilych.lilywb.cn");
assert.equal(bootstrap.modelGatewayBaseUrl, "https://lilych.lilywb.cn/llm");
assert.equal(bootstrap.edgeFallbackFrom, "https://lilyuae.lilywb.cn");
assert.equal(getServiceSettings().apiBaseUrl, "https://lilych.lilywb.cn");
assert.equal(requests[5]?.url, "https://lilyuae.lilywb.cn/api/client/bootstrap");
assert.equal(requests[6]?.url, "https://lilych.lilywb.cn/api/client/bootstrap");
assert.equal(requests[6]?.options?.headers?.["X-Lily-Region"], "uae");

global.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (String(url) === "https://lilyuae.lilywb.cn/api/client/bootstrap") {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        region: "uae",
        apiBaseUrl: "https://lilyuae.lilywb.cn",
        gatewayBaseUrl: "https://lilyuae.lilywb.cn",
        modelGatewayBaseUrl: "https://lilyuae.lilywb.cn/llm",
        features: { accountLogin: false, purchase: false, licenseActivation: true, modelDirect: false },
        routing: { modelMode: "gateway", releaseChannel: "domestic" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    };
  }
  throw new Error(`unexpected URL after edge recovery ${url}`);
};

const recovered = await refreshClientBootstrap();
assert.equal(recovered.ok, true);
assert.equal(recovered.apiBaseUrl, "https://lilyuae.lilywb.cn");
assert.equal(recovered.gatewayBaseUrl, "https://lilyuae.lilywb.cn");
assert.equal(recovered.modelGatewayBaseUrl, "https://lilyuae.lilywb.cn/llm");
assert.equal(recovered.edgeFallbackFrom, undefined);
assert.equal(getServiceSettings().apiBaseUrl, "https://lilyuae.lilywb.cn");
assert.equal(requests[7]?.url, "https://lilyuae.lilywb.cn/api/client/bootstrap");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("service-client-edge-fallback: ok");
