#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, ipcMain: { handle: () => {} } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-pack-ipc-location-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");
delete process.env.LILY_RUNTIME_PACK_ROOT;

try {
  const {
    chooseRuntimePackLocationForIpc,
    getRuntimePackLocationForIpc,
    resetRuntimePackLocationForIpc,
  } = require("../src/main/ipc-runtime-packs.js");

  const terminated = [];
  const ctx = {
    mainWindow: {},
    runnerPool: {
      getSessionIds: () => ["idle"],
      get: () => ({ isAlive: () => true, isBusy: () => false }),
      terminateSession: (id) => terminated.push(id),
    },
  };

  const initial = getRuntimePackLocationForIpc();
  assert.equal(initial.ok, true);
  assert.equal(initial.root, process.env.LILY_USER_DATA_DIR);
  assert.equal(initial.messageDbPath, path.join(process.env.LILY_USER_DATA_DIR, "messages.db"));

  const canceled = await chooseRuntimePackLocationForIpc(ctx, {}, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  });
  assert.equal(canceled.ok, false);
  assert.equal(canceled.canceled, true);
  assert.deepEqual(terminated, [], "canceled location picker must not restart runners");

  const selectedRoot = path.join(tmp, "external-dependencies");
  const selected = await chooseRuntimePackLocationForIpc(ctx, {}, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedRoot] }) },
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.root, selectedRoot);
  assert.equal(selected.packsRoot, path.join(selectedRoot, "runtime-packs"));
  assert.deepEqual(terminated, ["idle"], "successful location change should refresh idle runner env");

  terminated.length = 0;
  const reset = resetRuntimePackLocationForIpc(ctx);
  assert.equal(reset.ok, true);
  assert.equal(reset.root, process.env.LILY_USER_DATA_DIR);
  assert.deepEqual(terminated, ["idle"], "reset location should refresh idle runner env");
} finally {
  Module._load = originalLoad;
  delete process.env.LILY_RUNTIME_PACK_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("runtime-pack-ipc-location: ok");
