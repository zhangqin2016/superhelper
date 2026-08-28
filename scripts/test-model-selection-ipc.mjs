import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const handlers = new Map();
const calls = [];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
  if (request === "./model-presets") return {};
  if (request === "./model-selection-catalog") return {
    listModelSelectionPublic(sessionId) { calls.push(["list", sessionId]); return { models: [], selection: { mode: "auto" } }; },
    setModelSelectionPreference(selection, sessionId) { calls.push(["save", sessionId, selection]); return { ok: true, selection }; },
  };
  if (request === "./ipc-utils") return {
    refreshRemoteConfigForSend: async () => ({ ok: true }),
    withRunnerChange() { throw Error("a next-turn preference must not restart a runner"); },
  };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const { registerModelHandlers } = require("../src/main/ipc-models.js");
  registerModelHandlers({ sessionManager: { findById: id => id === "s1" ? { id } : null } });
  const list = handlers.get("models:selection-list");
  const save = handlers.get("models:set-selection");
  assert.equal((await list(null, { sessionId: "s1" })).ok, true);
  const selection = { mode: "manual", manualModelId: "published-id" };
  assert.equal(save(null, { selection, sessionId: "s1" }).ok, true);
  assert.deepEqual(calls, [["list", "s1"], ["save", "s1", selection]]);
  assert.equal((await list(null, { sessionId: "foreign" })).error, "SESSION_NOT_FOUND");
  assert.equal(save(null, { selection, sessionId: "foreign" }).error, "SESSION_NOT_FOUND");
  assert.equal(save(null, { selection, sessionId: {} }).error, "SESSION_NOT_FOUND");
  assert.equal(calls.length, 2, "unknown sessions never read or write preferences");
  assert.equal(save(null, selection).ok, true, "legacy unscoped callers remain compatible");
  console.log("model-selection-ipc: ok");
} finally { Module._load = originalLoad; }
