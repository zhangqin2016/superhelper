import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {
  normalizeSelection,
  routeTurn,
  estimateWorkload,
} from "../src/main/model-selection.js";
const require = createRequire(import.meta.url);
const { resolveOpencodeModelConfig } = require("../src/main/runtime/opencode-model-config.js");
const { buildOpencodePromptBody } = require("../src/main/runtime/opencode-message-parts.js");

const options = [
  { id: "fast", label: "Fast", modelID: "provider-fast", providerID: "lily" },
  { id: "quality", label: "Quality", modelID: "provider-quality", providerID: "lily", capabilities: { vision: true } },
];

const auto = normalizeSelection({ mode: "auto", autoModelIds: ["quality"] }, options);
assert.deepEqual(auto.autoModelIds, ["quality"]);
assert.equal(routeTurn({ selection: auto, options, text: "写一个简短的标题" }).model.id, "quality");

const manual = routeTurn({
  selection: { mode: "manual", manualModelId: "fast" },
  options,
  text: "请按我的要求处理",
});
assert.equal(manual.ok, true);
assert.equal(manual.mode, "manual");
assert.equal(manual.model.modelID, "provider-fast");

const image = routeTurn({
  selection: { mode: "auto", autoModelIds: ["fast", "quality"] },
  options,
  files: [{ mime: "image/png", path: "/tmp/example.png" }],
});
assert.equal(image.model.id, "quality");
assert.equal(image.reason, "vision_capability");
assert.equal(estimateWorkload("x", [{ mime: "image/png" }]).hasImages, true);

const invalid = routeTurn({
  selection: { mode: "manual", manualModelId: "does-not-exist" },
  options,
});
assert.equal(invalid.ok, false);
assert.equal(invalid.error, "INVALID_MODEL_SELECTION");

assert.equal(normalizeSelection({ mode: "auto", autoModelIds: [] }, options).autoModelIds.length, 2);

const runtime = resolveOpencodeModelConfig({
  LILY_API_BASE_URL: "https://example.test/v1",
  LILY_API_KEY: "test-token",
  LILY_MODEL: "provider-fast",
}, { modelPool: ["provider-fast", "provider-quality"] });
assert.equal(runtime.ok, true);
const provider = JSON.parse(runtime.configContent).provider.lily;
assert.deepEqual(Object.keys(provider.models).sort(), ["provider-fast", "provider-quality"]);
const body = buildOpencodePromptBody({
  text: "test",
  model: { providerID: "lily", modelID: "provider-quality" },
});
assert.deepEqual(body.model, { providerID: "lily", modelID: "provider-quality" });
console.log("model selection tests passed");

const ranked = options.map((model, index) => ({
  ...model, routing: { quality: index ? 100 : 80, cost: index ? 10 : 1 },
}));
test("Auto uses published quality/cost and never guesses ranks from list order", () => {
  const simple = routeTurn({ options: ranked, fallbackId: "fast", text: "hello" });
  const complex = routeTurn({ options: ranked, fallbackId: "fast", text: "x".repeat(9000) });
  assert.equal(simple.model.id, "fast");
  assert.equal(complex.model.id, "quality");
  assert.equal(routeTurn({ options: [...ranked].reverse(), fallbackId: "fast", text: "hello" }).model.id, "fast");
  assert.equal(routeTurn({ options, fallbackId: "quality", text: "hello" }).model.id, "quality", "unknown ranks retain the strong baseline");
  assert.equal(routeTurn({ options: ranked, fallbackId: "quality", text: "hello" }).model.id, "quality", "cost savings never lower the baseline quality floor");
});
test("an expired custom pool never expands into models the user did not select", () => {
  const result = routeTurn({ options, selection: { mode: "auto", autoModelIds: ["removed"] } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "NO_ELIGIBLE_MODEL");
  assert.deepEqual(result.selection.autoModelIds, []);
  assert.equal(routeTurn({ options, selection: result.selection }).ok, false, "normalization is idempotent");
});
test("an empty explicitly custom pool remains empty", () => {
  const result = routeTurn({ options, selection: { mode: "auto", autoPoolMode: "custom", autoModelIds: [] } });
  assert.equal(result.error, "NO_ELIGIBLE_MODEL");
});

function catalogFixture({ custom = false, failWrite = false, stored = null, catalogUnavailable = false, noProfile = false, readError = null, baseEnv = {} } = {}) {
  const activeEnv = { LILY_MODEL: "provider-fast", LILY_API_BASE_URL: "https://one.test/anthropic", LILY_OPENCODE_PROTOCOL: "anthropic" };
  const presets = [
    { id: "fast", label: "One", model: "provider-fast", custom, env: activeEnv },
    { id: "quality", label: "Two", model: "provider-quality", custom: false,
      routing: { quality: 100, cost: 10 },
      env: { LILY_MODEL: "provider-quality", LILY_API_BASE_URL: "https://two.test/v1", LILY_OPENCODE_PROTOCOL: "openai" } },
  ];
  let saved = stored;
  let pending;
  const mockFs = {
    readFileSync: () => { if (readError) throw readError; return JSON.stringify(saved); }, mkdirSync() {},
    writeFileSync(_file, text) { if (failWrite) throw Object.assign(new Error("read only"), { code: "EACCES" }); pending = JSON.parse(text); },
    renameSync() { saved = pending; }, unlinkSync() {},
  };
  const mocks = {
    "node:fs": mockFs,
    "./config": { userDataPath: () => { if (noProfile) throw Error("no desktop profile"); return "/virtual/selection.json"; } },
    "./model-presets": {
      listPresetsPublic: () => { if (catalogUnavailable) throw Error("catalog offline"); return { activePresetId: "fast", presets }; },
      getActivePresetId: () => "fast",
      getActivePresetEnv: () => custom ? { LILY_MODEL: "provider-fast" } : activeEnv,
    },
    "./spawn-env": { resolveLilyEnv: () => activeEnv },
    "./agent-settings": { loadSettingsEnv: () => baseEnv },
    "./remote-config": { getRemoteModelCatalogSync: () => ({ presets }), getRemoteRuntimeEnvSync: () => ({}) },
    "./agent-env": { normalizeToLilyEnv: value => value },
    "./model-selection": require("../src/main/model-selection.js"),
    "./runtime/opencode-model-config": require("../src/main/runtime/opencode-model-config.js"),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/main/model-selection-catalog.js", import.meta.url), "utf8"), {
    module, exports: module.exports, process, Buffer,
    require: id => mocks[id] || createRequire(new URL("../src/main/model-selection-catalog.js", import.meta.url))(id),
  });
  return module.exports;
}
test("selection write failures are returned, not reported as saved", () => {
  const catalog = catalogFixture({ failWrite: true });
  assert.equal(catalog.setModelSelectionPreference({ mode: "manual", manualModelId: "quality" }).ok, false);
});
test("unavailable metadata falls back only for recommended Auto, never an explicit saved choice", () => {
  assert.equal(catalogFixture({ catalogUnavailable: true }).resolveTurnModel().ok, true);
  assert.equal(catalogFixture({ catalogUnavailable: true, noProfile: true }).resolveTurnModel().reason, "legacy_active_model");
  const manual = catalogFixture({ catalogUnavailable: true, stored: { mode: "manual", manualModelId: "quality" } }).resolveTurnModel();
  assert.equal(manual.ok, false);
  const custom = catalogFixture({ catalogUnavailable: true, stored: { mode: "auto", autoPoolMode: "custom", autoModelIds: ["quality"] } }).resolveTurnModel();
  assert.equal(custom.ok, false);
});
test("an unreadable saved preference is not confused with no desktop profile", () => {
  const route = catalogFixture({ readError: Object.assign(Error("denied"), { code: "EACCES" }) }).resolveTurnModel();
  assert.equal(route.error, "MODEL_SELECTION_READ_FAILED");
});
test("Auto excludes known tool/context-incompatible models without pretending unknown metadata is weak", () => {
  const limited = ranked.map(model => ({ ...model, capabilities: { toolCall: model.id !== "fast" }, limits: { contextTokens: model.id === "fast" ? 4096 : 128000 } }));
  assert.equal(routeTurn({ options: limited, fallbackId: "fast", requirements: { tools: true, contextTokens: 10000 } }).model.id, "quality");
  assert.equal(routeTurn({ options: limited, requirements: { contextTokens: 200000 } }).error, "NO_ELIGIBLE_MODEL");
  assert.equal(routeTurn({ options, fallbackId: "quality", requirements: { contextTokens: 10000 } }).model.id, "quality");
});
test("manual invalid IDs are rejected instead of replaced by the active model", () => {
  assert.equal(catalogFixture().setModelSelectionPreference({ mode: "manual", manualModelId: "missing" }).ok, false);
});
test("model preferences are isolated by conversation and preserve legacy defaults", () => {
  const catalog = catalogFixture({ stored: { mode: "manual", manualModelId: "fast" } });
  assert.equal(catalog.listModelSelectionPublic("new").selection.manualModelId, "fast");
  assert.equal(catalog.setModelSelectionPreference({ mode: "manual", manualModelId: "quality" }, "s1").ok, true);
  assert.equal(catalog.setModelSelectionPreference({ mode: "auto", autoPoolMode: "custom", autoModelIds: ["fast"] }, "s2").ok, true);
  assert.equal(catalog.listModelSelectionPublic("s1").selection.manualModelId, "quality");
  assert.equal(catalog.listModelSelectionPublic("s2").selection.mode, "auto");
  assert.equal(catalog.listModelSelectionPublic().selection.manualModelId, "fast");
  assert.equal(catalog.resolveTurnModel({ sessionId: "s1" }).model.id, "quality");
});
test("custom Anthropic refs use the actual resolved runtime connection", () => {
  const route = catalogFixture({ custom: true }).resolveTurnModel({ selection: { mode: "manual", manualModelId: "fast" } });
  assert.match(route.model.providerID, /^lily-model-/);
  assert.equal(route.execution.env.LILY_OPENCODE_PROTOCOL, "anthropic");
  assert.equal(route.execution.env.LILY_API_BASE_URL, "https://one.test/anthropic");
});
test("published models keep separate provider endpoints in runtime configuration", () => {
  const catalog = catalogFixture();
  const state = catalog.listModelSelectionPublic();
  const resolved = resolveOpencodeModelConfig({
    LILY_MODEL: "provider-fast", LILY_API_BASE_URL: "https://one.test/anthropic", LILY_OPENCODE_PROTOCOL: "anthropic",
  }, { modelPool: catalog.listRuntimeModelIds() });
  const providers = JSON.parse(resolved.configContent).provider;
  const model = state.models.find(item => item.id === "quality");
  assert.equal(providers[model.providerID].options.baseURL, "https://two.test/v1");
  assert.ok(providers[model.providerID].models[model.modelID]);
  assert.equal(model.routing.quality, 100);
  assert.equal(JSON.stringify(state).includes("https://two.test"), false, "public catalog excludes connections and secrets");
});
test("manual selection survives insertions and internal continuations on the same conversation", async () => {
  const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
  const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");
  const selected = { providerID: "lily", modelID: "chosen" };
  const bodies = [];
  const server = { sessionID: "same-session", model: { providerID: "lily", modelID: "default" }, env: {},
    _sdkSession: { promptAsync: async (id, body) => bodies.push({ id, model: body.model }) } };
  server.sendPrompt = payload => OpencodeServerManager.prototype.sendPrompt.call(server, payload);
  await server.sendPrompt({ text: "original", files: [], model: selected });
  const session = {
    busy: true, _turnSettled: false, _server: server, _pendingPromptPayload: { model: selected }, spawnOptions: {},
    _armResponseTimer() {}, _armProgressNoticeTimer() {},
    _pendingPermissions: new Map(), _pendingQuestions: new Map(),
    _latestTodos: [{ content: "finish", status: "pending" }], _todoCompletionGateAttempts: 0,
  };
  await OpencodeAgentSession.prototype.steer.call(session, { text: "insert" });
  OpencodeAgentSession.prototype._continueUnfinishedTodosBeforeCompletion.call(session, { code: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bodies.map(body => body.model.modelID), ["chosen", "chosen", "chosen"]);
  assert.ok(bodies.every(body => body.id === "same-session"));
  await server.sendPrompt({ text: "next user turn", model: null });
  assert.equal(bodies.at(-1).model.modelID, "default", "a new legacy turn clears the previous override");
});
test("retry and restart recovery inherit the stored route, not the latest preference", () => {
  const catalog = catalogFixture();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/main/turn-model-runtime.js", import.meta.url), "utf8"), {
    module, exports: module.exports,
    require: id => id === "./model-selection-catalog" ? catalog : createRequire(new URL("../src/main/turn-model-runtime.js", import.meta.url))(id),
  });
  const runtime = module.exports;
  const initial = catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: "quality" } });
  const receipt = runtime.routeTrace(initial);
  let lookup;
  const route = runtime.resolveTurnModel({ sourceTurnId: "source" }, "retry", [], {
    sessionId: "s1", manager: { getTurnInputByTurnId: (sessionId, turnId) => {
      lookup = [sessionId, turnId];
      return { sessionId, turnId, metadata: { modelRoute: JSON.parse(JSON.stringify(receipt)) } };
    } },
  });
  assert.deepEqual(lookup, ["s1", "source"]);
  assert.equal(route.model.id, "quality");
  assert.equal(route.reason, "inherited_turn");
});

test("an inactive model cannot inherit another model's limits or compatibility recipes", () => {
  const catalog = catalogFixture({ baseEnv: { LILY_CONTEXT_WINDOW_TOKENS: "1000000", LILY_MODEL_CAPABILITY_GRADE: "lite", LILY_MODEL_RECIPES: "{\"toolCallHint\":true}" } });
  const route = catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: "quality" } });
  assert.equal(route.model.limits.contextTokens, null);
  assert.equal(route.execution.env.LILY_MODEL_CAPABILITY_GRADE, undefined);
  assert.equal(route.execution.env.LILY_MODEL_RECIPES, undefined);
  assert(Object.isFrozen(route.execution.env));
  assert.equal(JSON.stringify(catalog.listModelSelectionPublic()).includes("one.test"), false, "private connection data must not enter IPC");
});

test("inactive model connections cannot inherit global OpenCode transport overrides", () => {
  const catalog = catalogFixture({ baseEnv: {
    LILY_OPENCODE_MODEL: "global-model", LILY_OPENCODE_BASE_URL: "https://global.test/v1", LILY_OPENCODE_API_KEY: "global-secret",
    LILY_GATEWAY_PROVIDER: "wrong-provider", VISION_MODEL: "keep-vision",
  } });
  const route = catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: "quality" } });
  assert.equal(route.model.modelID, "provider-quality");
  assert.equal(route.execution.env.LILY_OPENCODE_API_KEY, undefined);
  assert.equal(route.execution.env.LILY_OPENCODE_BASE_URL, undefined);
  assert.equal(route.execution.env.LILY_GATEWAY_PROVIDER, undefined);
  assert.equal(route.execution.env.VISION_MODEL, "keep-vision");
});
