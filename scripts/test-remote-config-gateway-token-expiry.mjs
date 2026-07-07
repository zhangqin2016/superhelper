#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-remote-config-token-"));
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: () => tempRoot,
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
  },
};

function b64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function gatewayToken(expiresAt) {
  return `lilygw.${b64url({ expiresAt })}.sig`;
}

function writeCache(token) {
  const state = {
    schemaVersion: 1,
    configVersion: "test",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    effectiveConfig: {
      models: {
        activePresetId: "managed",
        presets: [{
          id: "managed",
          label: "Managed",
          env: {
            LILY_API_KEY: token,
            LILY_PROVIDER_ID: "lily",
          },
        }],
      },
      runtime: {
        env: {
          LILY_API_KEY: token,
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
}

const remoteConfig = require("../src/main/remote-config.js");

writeCache(gatewayToken(new Date(Date.now() + 60 * 60_000).toISOString()));
remoteConfig.reloadRemoteConfigCache();
assert.equal(remoteConfig.hasRemoteModelCatalogSync(), true, "valid gateway token keeps remote catalog usable");
assert.equal(remoteConfig.getRemoteRuntimeEnvSync().LILY_API_KEY.startsWith("lilygw."), true);

writeCache(gatewayToken(new Date(Date.now() - 60_000).toISOString()));
remoteConfig.reloadRemoteConfigCache();
assert.equal(remoteConfig.hasRemoteModelCatalogSync(), false, "expired gateway token should force send-preflight refresh");
assert.equal(remoteConfig.getRemoteModelCatalogSync(), null);
assert.deepEqual(remoteConfig.getRemoteRuntimeEnvSync(), {}, "expired gateway token must not feed stale env to the engine");
assert.equal(remoteConfig.effectiveConfigHasExpiredGatewayToken({
  models: { presets: [{ env: { LILY_API_KEY: gatewayToken(new Date(Date.now() - 1).toISOString()) } }] },
}), true);
assert.equal(remoteConfig.effectiveConfigHasExpiredGatewayToken({
  models: { presets: [{ env: { LILY_API_KEY: "$LILY_GATEWAY_TOKEN" } }] },
}), true, "gateway token placeholder must force config refresh before send");
assert.equal(remoteConfig.effectiveConfigHasExpiredGatewayToken({
  models: { presets: [{ env: { LILY_API_KEY: "lilygw.not-json.sig" } }] },
}), true, "malformed gateway tokens must force config refresh before send");

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("remote-config gateway token expiry: ok");
