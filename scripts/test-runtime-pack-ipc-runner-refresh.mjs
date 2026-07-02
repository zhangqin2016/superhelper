#!/usr/bin/env node

import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { ipcMain: { handle: () => {} } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const {
    installRuntimePackForIpc,
    uninstallRuntimePackForIpc,
  } = require("../src/main/ipc-runtime-packs.js");

  const terminated = [];
  const runners = new Map([
    ["idle", { isAlive: () => true, isBusy: () => false }],
    ["busy", { isAlive: () => true, isBusy: () => true }],
  ]);
  const ctx = {
    runnerPool: {
      getSessionIds: () => [...runners.keys()],
      get: (id) => runners.get(id),
      terminateSession: (id) => terminated.push(id),
    },
  };

  const install = await installRuntimePackForIpc(ctx, { id: "large-document" }, {
    installer: { installRuntimePack: async (id) => ({ ok: true, installed: id }) },
  });
  assert.equal(install.installed, "large-document");
  assert.deepEqual(install.runnerRefresh, { terminated: ["idle"] }, "successful install refreshes idle runner env");
  assert.deepEqual(terminated, ["idle"], "busy runners are left alone during dependency refresh");

  terminated.length = 0;
  const failed = await installRuntimePackForIpc(ctx, { id: "bad" }, {
    installer: { installRuntimePack: async () => ({ ok: false, error: "NO_ARTIFACT" }) },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(terminated, [], "failed install must not restart runners");

  const uninstall = uninstallRuntimePackForIpc(ctx, { id: "large-document" }, {
    installer: { uninstallRuntimePack: (id) => ({ ok: true, uninstalled: id }) },
  });
  assert.equal(uninstall.uninstalled, "large-document");
  assert.deepEqual(uninstall.runnerRefresh, { terminated: ["idle"] }, "successful uninstall refreshes idle runner env");
} finally {
  Module._load = originalLoad;
}

console.log("runtime-pack-ipc-runner-refresh: ok");
