#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-service-region-recheck-"));

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
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
delete process.env.LILY_CLIENT_REGION;
delete process.env.CLIENT_REGION;

fs.writeFileSync(
  path.join(tmp, "client-bootstrap-policy.json"),
  JSON.stringify({
    ok: true,
    schemaVersion: 1,
    source: "remote",
    region: "china",
    apiBaseUrl: "https://lilych.lilywb.cn",
    gatewayBaseUrl: "https://lilych.lilywb.cn",
    modelGatewayBaseUrl: "https://lilych.lilywb.cn/llm",
    features: { accountLogin: true, purchase: true, usage: true },
    routing: { modelMode: "gateway" },
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  }),
);

const requests = [];
global.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  assert.equal(url, "https://lilych.lilywb.cn/api/client/bootstrap");
  return {
    ok: true,
    json: async () => ({
      ok: true,
      region: "uae",
      apiBaseUrl: "https://lilyxinjiapo.lilywb.cn",
      gatewayBaseUrl: "https://lilyxinjiapo.lilywb.cn",
      modelGatewayBaseUrl: "https://lilyxinjiapo.lilywb.cn/llm",
      features: { accountLogin: false, purchase: false, licenseActivation: true, usage: true, modelDirect: false },
      routing: { modelMode: "gateway", releaseChannel: "domestic" },
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    }),
  };
};

const { getServiceSettings, refreshClientBootstrap } = require(path.join(__dirname, "../src/main/service-client.js"));

assert.equal(getServiceSettings().apiBaseUrl, "https://lilych.lilywb.cn");
const policy = await refreshClientBootstrap();
assert.equal(policy.region, "uae");
assert.equal(policy.apiBaseUrl, "https://lilyxinjiapo.lilywb.cn");
assert.equal(getServiceSettings().apiBaseUrl, "https://lilyxinjiapo.lilywb.cn");
assert.equal(requests.length, 1, "unexpired auto-detected China cache should still be rechecked");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("service-client-region-recheck: ok");
