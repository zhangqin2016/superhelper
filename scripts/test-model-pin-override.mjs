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

// --- 2026-09-27: a retry must ESCAPE a failed / deselected / avoided model ---
const availPath = require.resolve("../src/main/model-availability.js");
const realAvail = require(availPath);
let marked = new Set();
require.cache[availPath] = {
  id: availPath, filename: availPath, loaded: true,
  exports: { ...realAvail, getModelAvailability: (m) => (marked.has(`${m.providerID}/${m.modelID}`) ? { reason: "failed" } : null) },
};
delete require.cache[require.resolve("../src/main/turn-model-runtime.js")];
const { resolveTurnModel: resolveH } = require("../src/main/turn-model-runtime.js");
const autoReceipt = { selectionId: "claude", modelId: "claude", providerId: "p", selection: { mode: "auto", autoModelIds: ["claude", "deepseek"] } };
const autoManager = { getTurnInputByTurnId: (sessionId, turnId) => (turnId === SOURCE_TURN ? { sessionId, turnId, metadata: { modelRoute: autoReceipt } } : null) };
const autoCtx = { manager: autoManager, sessionId: "s1" };
const resolve2 = (opts = {}) => resolveH({ sourceTurnId: SOURCE_TURN, ...opts }, "继续", [], autoCtx);

check("auto: a retry drops the pin when the source model has an availability mark", () => {
  sessionSelection = { mode: "auto", autoModelIds: ["claude", "deepseek"] };
  marked = new Set(["p/claude"]);
  assert.equal(resolve2().input.pinnedModelId, "", "a failed source model is not re-pinned");
  marked = new Set();
});

check("an explicitly avoided source model is never re-pinned (failover)", () => {
  sessionSelection = { mode: "auto", autoModelIds: ["claude", "deepseek"] };
  const route = resolve2({ avoidModelIds: ["claude"] });
  assert.equal(route.input.pinnedModelId, "");
  assert.deepEqual(route.input.avoidModelIds, ["claude"], "the avoid list reaches routing");
});

check("auto: a retry drops the pin when the source model is no longer selected", () => {
  sessionSelection = { mode: "auto", autoModelIds: ["deepseek"] };
  assert.equal(resolve2().input.pinnedModelId, "");
});

check("auto: a healthy, still-selected source model keeps its pin", () => {
  sessionSelection = { mode: "auto", autoModelIds: ["claude", "deepseek"] };
  marked = new Set();
  assert.equal(resolve2().input.pinnedModelId, "claude");
});

check("a MANUAL source pick is never overridden by an availability mark", () => {
  sessionSelection = null;
  marked = new Set(["company/deepseek-v4-flash-0731", "/company/deepseek-v4-flash-0731"]);
  assert.equal(resolve().input.pinnedModelId, "company/deepseek-v4-flash-0731");
  marked = new Set();
});

console.log(`\n${checks} checks passed (model pin override)`);
