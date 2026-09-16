#!/usr/bin/env node
// A retry or continuation replays the SOURCE turn's model so continued work
// stays on the model that produced it. When the user has since picked a model
// by hand, that later choice must win — otherwise switching away from a broken
// model and pressing 重试 runs on the broken model again (2026-09-16: switched
// off the company DeepSeek, still got "no available service channel for model
// deepseek-ai/DeepSeek-V4-Flash-0731"). [gate: auto-model-selection]
// Run: node scripts/test-model-pin-override.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

// The unit under test reads the CURRENT session selection through the catalog.
const catalogPath = require.resolve("../src/main/model-selection-catalog.js");
let sessionSelection = null;
const realCatalog = require(catalogPath);
require.cache[catalogPath] = {
  id: catalogPath, filename: catalogPath, loaded: true,
  exports: {
    ...realCatalog,
    getSessionModelSelection: () => sessionSelection,
    resolveTurnModel: (input) => ({ ok: true, input, model: { modelID: input.pinnedModelId || input.selection?.manualModelId || "auto", providerID: "p" } }),
  },
};
const { resolveTurnModel } = require("../src/main/turn-model-runtime.js");

const SOURCE_TURN = "turn-source";
const receipt = { selectionId: "company/deepseek-v4-flash-0731", selection: { mode: "manual", manualModelId: "company/deepseek-v4-flash-0731" }, modelId: "" };
const manager = { getTurnInputByTurnId: (sessionId, turnId) => (turnId === SOURCE_TURN ? { sessionId, turnId, metadata: { modelRoute: receipt } } : null) };
const context = { manager, sessionId: "s1" };
const resolve = () => resolveTurnModel({ sourceTurnId: SOURCE_TURN }, "继续", [], context);

check("with no manual pick, a continuation stays on the model that did the work", () => {
  sessionSelection = null;
  assert.equal(resolve().input.pinnedModelId, "company/deepseek-v4-flash-0731");
  sessionSelection = { mode: "auto", manualModelId: "" };
  assert.equal(resolve().input.pinnedModelId, "company/deepseek-v4-flash-0731", "an automatic selection does not overrule the pin");
});

check("a manual pick made AFTER the source turn overrules the pin", () => {
  sessionSelection = { mode: "manual", manualModelId: "deepseek-v4-flash" };
  const route = resolve();
  assert.equal(route.input.pinnedModelId, "", "the dead model is no longer pinned");
  assert.notEqual(route.input.selection?.manualModelId, "company/deepseek-v4-flash-0731");
});

check("re-picking the SAME model keeps the pin, so nothing changes needlessly", () => {
  sessionSelection = { mode: "manual", manualModelId: "company/deepseek-v4-flash-0731" };
  assert.equal(resolve().input.pinnedModelId, "company/deepseek-v4-flash-0731");
});

check("a turn with no source is untouched, and a broken store never breaks the send", () => {
  sessionSelection = { mode: "manual", manualModelId: "deepseek-v4-flash" };
  assert.equal(resolveTurnModel({}, "hi", [], context).input.pinnedModelId, "");
  const broken = require("../src/main/turn-model-runtime.js");
  require.cache[catalogPath].exports.getSessionModelSelection = () => { throw new Error("store unreadable"); };
  assert.equal(broken.resolveTurnModel({ sourceTurnId: SOURCE_TURN }, "继续", [], context).input.pinnedModelId,
    "company/deepseek-v4-flash-0731", "an unreadable store falls back to the pin rather than failing");
  require.cache[catalogPath].exports.getSessionModelSelection = () => sessionSelection;
  const src = fs.readFileSync(new URL("../src/main/turn-model-runtime.js", import.meta.url), "utf8");
  assert.match(src, /manualOverrideAfterSource/);
});

console.log(`\n${checks} checks passed (model pin override)`);
