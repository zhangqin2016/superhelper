#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const originalLoad = Module._load;
const handlers = new Map();
const invocations = [];
let exposedClient = null;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      contextBridge: {
        exposeInMainWorld(name, value) {
          if (name === "assistantClient") exposedClient = value;
        },
      },
      dialog: {},
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      ipcRenderer: {
        invoke(...args) {
          invocations.push(args);
          return Promise.resolve({ ok: true });
        },
        on() {},
        send() {},
      },
      shell: {},
      webUtils: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerProjectHandlers } = require(path.join(ROOT, "src/main/ipc-projects.js"));
  const appState = { projects: [{ id: "alpha" }, { id: "beta" }] };
  const reorderCalls = [];
  const projectManager = {
    getAppState: () => appState,
    reorder(projectIds) {
      reorderCalls.push(projectIds);
    },
  };

  registerProjectHandlers({
    mainWindow: {},
    projectManager,
    sessionManager: {},
    runnerPool: {},
  });

  assert.equal(handlers.has("project:reorder"), true, "main process registers project:reorder");
  assert.equal(handlers.has("project:pin"), false, "main process no longer registers project:pin");

  const ids = ["beta", "alpha"];
  assert.deepEqual(
    await handlers.get("project:reorder")({}, ids),
    { ok: true, state: appState },
    "reorder returns the canonical app state",
  );
  assert.equal(reorderCalls.length, 1);
  assert.equal(reorderCalls[0], ids, "reorder forwards the exact projectIds array");

  const validationError = Object.assign(new Error("invalid order"), {
    code: "INVALID_PROJECT_ORDER",
  });
  projectManager.reorder = () => {
    throw validationError;
  };
  await assert.rejects(
    () => handlers.get("project:reorder")({}, ["alpha"]),
    (error) => error === validationError,
    "project ordering errors reject the IPC call unchanged",
  );

  require(path.join(ROOT, "src/preload.js"));
  assert.ok(exposedClient, "preload exposes assistantClient");
  assert.equal(typeof exposedClient.reorderProjects, "function", "preload exposes reorderProjects");
  assert.equal("pinProject" in exposedClient, false, "preload no longer exposes pinProject");

  const bridgeIds = ["alpha", "beta"];
  await exposedClient.reorderProjects(bridgeIds);
  assert.deepEqual(
    invocations.at(-1),
    ["project:reorder", bridgeIds],
    "preload forwards projectIds through project:reorder",
  );

  const ipcSource = read("src/main/ipc-projects.js");
  const preloadSource = read("src/preload.js");
  const mobilePairingSource = read("src/main/ipc-mobile-pairing.js");
  assert.equal(ipcSource.includes("project:pin"), false, "project:pin is removed from main IPC");
  assert.equal(ipcSource.includes("togglePin"), false, "togglePin is removed from main IPC");
  assert.equal(preloadSource.includes("pinProject"), false, "pinProject is removed from preload");
  assert.equal(
    mobilePairingSource.includes("pinned:"),
    false,
    "mobile workspace summaries no longer expose obsolete pinned state",
  );
} finally {
  Module._load = originalLoad;
}

console.log("workspace-project-contract: ok");
