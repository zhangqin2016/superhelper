#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-service-bootstrap-"));

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
  if (String(url).endsWith("/api/client/bootstrap")) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        region: "uae",
        apiBaseUrl: "https://lilyxinjiapo.lilywb.cn",
        gatewayBaseUrl: "https://lilyxinjiapo.lilywb.cn",
        modelGatewayBaseUrl: "https://lilyxinjiapo.lilywb.cn/llm",
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
  return { ok: true, json: async () => ({ ok: true }) };
};

const {
  getClientPolicy,
  getServiceSettings,
  refreshClientBootstrap,
  workspaceAppCatalog,
} = require(path.join(__dirname, "../src/main/service-client.js"));

if (getServiceSettings().apiBaseUrl !== "https://lilyxinjiapo.lilywb.cn") {
  throw new Error(`UAE local default service base should be Singapore edge before bootstrap: ${JSON.stringify(getServiceSettings())}`);
}

const bootstrap = await refreshClientBootstrap({ force: true });
if (!bootstrap.ok || bootstrap.region !== "uae") {
  throw new Error(`bootstrap should return UAE policy: ${JSON.stringify(bootstrap)}`);
}
if (getClientPolicy().features.accountLogin !== false || getClientPolicy().features.purchase !== false) {
  throw new Error(`UAE policy should disable account login and purchase: ${JSON.stringify(getClientPolicy())}`);
}
if (getServiceSettings().apiBaseUrl !== "https://lilyxinjiapo.lilywb.cn") {
  throw new Error(`service base should switch to UAE gateway: ${JSON.stringify(getServiceSettings())}`);
}

if (getClientPolicy().features.enterpriseAccountLogin !== true) {
  throw new Error("overseas bootstrap must retain enterprise password login");
}

await workspaceAppCatalog();
if (requests[0]?.url !== "https://lilyxinjiapo.lilywb.cn/api/client/bootstrap") {
  throw new Error(`UAE bootstrap should use edge host immediately: ${requests[0]?.url}`);
}
if (requests[0]?.options?.headers?.["X-Lily-Region"] !== "uae") {
  throw new Error(`bootstrap should send local UAE region hint: ${JSON.stringify(requests[0]?.options?.headers)}`);
}
if (!requests[0]?.options?.headers?.["X-Lily-Timezone"]) {
  throw new Error(`bootstrap should send local timezone for server-side region fallback: ${JSON.stringify(requests[0]?.options?.headers)}`);
}
if (requests[1]?.url !== "https://lilyxinjiapo.lilywb.cn/api/apps/catalog") {
  throw new Error(`post-bootstrap API should use UAE gateway: ${requests[1]?.url}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("service-client-bootstrap: ok");
