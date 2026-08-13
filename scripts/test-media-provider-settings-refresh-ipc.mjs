#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const handlers = new Map();
const calls = { refresh: [] };
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "./model-presets") return {};
  if (request === "./ipc-utils") {
    return {
      withRunnerChange: (_ctx, work) => work(),
      applyPermissionModeLive: () => {},
      refreshRemoteConfigForSend: async (options) => {
        calls.refresh.push(options);
        return { ok: true };
      },
    };
  }
  if (request === "./media-provider-settings") return { listMediaProvidersPublic: () => ({ image: {}, providers: [] }) };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerMediaProviderHandlers } = require("../src/main/ipc-models.js");
  registerMediaProviderHandlers({});
  const result = await handlers.get("media-providers:list")();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.refresh, [{ force: true, timeoutMs: 1500, reason: "media_provider_settings" }]);
  console.log("media provider settings refresh ipc: ok");
} finally {
  Module._load = originalLoad;
}
