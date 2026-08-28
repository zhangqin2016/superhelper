import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { routeTurn, normalizeOption } from "../src/main/model-selection.js";
import { buildEnvManagedClientConfig } from "../server/src/services/client-config.js";

const require = createRequire(import.meta.url);
function isolated(name, mocks = {}) {
  const url = new URL(`../src/main/${name}`, import.meta.url);
  const nativeRequire = createRequire(url);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(url, "utf8"), {
    module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout, queueMicrotask,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
  }, { filename: url.pathname });
  return module.exports;
}
const option = (id, quality, cost, capabilities = {}, contextTokens = 128000) => ({
  id, modelID: id, providerID: "lily", routing: { quality, cost }, capabilities, limits: { contextTokens },
});

test("image preference cannot lower the existing reasoning quality floor", () => {
  const options = [option("strong", 100, 10), option("weak-vision", 20, 1, { vision: true })];
  assert.equal(routeTurn({ options, fallbackId: "strong", files: [{ mime: "image/png" }] }).model.id, "strong");
  const unknown = options.map(model => ({ ...model, routing: undefined }));
  assert.equal(routeTurn({ options: unknown, fallbackId: "strong", files: [{ mime: "image/png" }] }).model.id, "strong");
});

test("main turn derives tool/context requirements rather than trusting an unfiltered menu", () => {
  const options = [option("baseline", 80, 10), option("no-tools", 90, 1, { toolCall: false }, 8000)];
  const runtime = isolated("turn-model-runtime.js", {
    "./model-selection-catalog": { resolveTurnModel: input => routeTurn({ ...input, options, fallbackId: "baseline" }) },
  });
  assert.equal(runtime.resolveTurnModel({}, "Update the workbook", [], { sessionId: "s" }).model.id, "baseline");
});

test("Auto prefers a fitting window but does not disable existing bulk-input staging", () => {
  const small = option("small", 100, 1, {}, 32000);
  const large = option("large", 100, 10, {}, 1000000);
  const runtimeFor = options => isolated("turn-model-runtime.js", {
    "./model-selection-catalog": { resolveTurnModel: input => routeTurn({ ...input, options, fallbackId: "small" }) },
  });
  const text = "x".repeat(200000);
  assert.equal(runtimeFor([small, large]).resolveTurnModel({}, text, [], { sessionId: "s" }).model.id, "large");
  const fallback = runtimeFor([small]).resolveTurnModel({}, text, [], { sessionId: "s" });
  assert.equal(fallback.ok, true, "the existing staging/compaction path must remain reachable");
  assert.equal(fallback.model.id, "small");
});

test("pre-turn compaction and normalized limits use the selected model, not runner startup", async () => {
  const runtime = isolated("context-compaction-runtime.js", {
    "./logger": { getLogger: () => ({ warn() {} }) },
    "./session-memory": { readSessionSummary: () => ({ retainedContextTokens: 90000 }), writeSessionSummary() {}, markSessionCompactionFailed() {} },
  }).createContextCompactionRuntime();
  const selected = normalizeOption(option("small", 100, 1, {}, 32000));
  let compactModel;
  const result = await runtime.maybeCompactBeforeTurn("s", {
    spawnOptions: { model: { providerID: "lily", modelID: "large", contextWindowTokens: 1000000 } },
    isAlive: () => true, isBusy: () => false,
    compactContext: async model => { compactModel = model; return true; },
  }, { text: "continue", model: selected });
  assert.equal(result.contextWindowTokens, 32000);
  assert.equal(result.action, "compact");
  assert.equal(compactModel.modelID, "small");
  assert.equal(require("../src/main/context-budget-manager.js").resolveContextBudget({ model: selected }).contextWindowTokens, 32000);
});

test("queued recovery retains the exact same model as direct recovery", async () => {
  const options = [option("original", 100, 10), option("new-selection", 100, 1)];
  const runtime = isolated("turn-model-runtime.js", {
    "./model-selection-catalog": { resolveTurnModel: input => routeTurn({ ...input, selection: input.selection || { mode: "manual", manualModelId: "new-selection" }, options }) },
  });
  const manager = { findById: () => ({ id: "s" }), getTurnInputByTurnId: () => ({ sessionId: "s", metadata: { modelRoute: { selectionId: "original", selection: { mode: "manual", manualModelId: "original" } } } }) };
  const dispatch = isolated("turn-queue-dispatch.js", {
    "./turn-start-guard": { guardTurnStart: (_host, _session, text, files, opts) => runtime.resolveTurnModel(opts, text, files, { manager, sessionId: "s" }) },
  }).createTurnQueueDispatchMethods({
    log: { warn() {} },
    ...require("../src/main/scheduled-task-turn-options.js"),
    documentDeliveryDispatchOptions: require("../src/main/document-delivery-turn.js").documentDeliveryDispatchOptions,
  });
  const result = await dispatch._tryStartQueuedItem.call({ ctx: { sessionManager: manager, runnerPool: { get: () => null } } }, "s", { text: "retry", files: [], options: { sourceTurnId: "source-turn" } });
  assert.equal(result.model.id, "original");
});

test("model-specific capability declarations override provider defaults, including false", () => {
  const managed = buildEnvManagedClientConfig({ modelGatewayDefaultProvider: "mixed", modelConfigDeliveryMode: "gateway" }, {
    mixed: { id: "mixed", type: "anthropic", baseUrl: "https://example.test/v1", apiKey: "fixture", models: ["text-only", "native-vision"],
      metadata: { nativeVision: true, models: { "text-only": { capabilities: { vision: false, toolCall: false } }, "native-vision": { capabilities: { vision: true, toolCall: true, filePartMimes: ["application/pdf"] } } } } },
  });
  const text = managed.models.presets.find(p => p.env.LILY_MODEL === "text-only");
  const vision = managed.models.presets.find(p => p.env.LILY_MODEL === "native-vision");
  assert.equal(text.capabilities.vision, false);
  assert.equal(text.capabilities.toolCall, false);
  assert.deepEqual(vision.capabilities.filePartMimes, ["application/pdf"]);
});

test("usage is attributed to the admitted and reported model, never the global choice", async () => {
  const reports = [];
  const usage = isolated("usage-reporter.js", {
    "./model-presets": { getActivePresetEnv: () => ({ LILY_MODEL: "global" }), getUserApiEnv: () => ({}) },
    "./agent-env": { normalizeToLilyEnv: x => x, pickModelId: x => x.LILY_MODEL },
    "./license-manager": { getLicenseStatus: () => ({}) },
    "./usage-local-store": { mergeSessionRecord() {} },
    "./service-client": { reportUsage: async value => { reports.push(value); return { ok: true }; } },
  });
  usage.recordUserSend("s", [], { modelID: "selected" });
  usage.recordModelUsage("s", { selected: { inputTokens: 100, outputTokens: 20 } });
  await usage.flush("s");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].model, "selected");
  assert.equal(reports[0].inputTokens, 100);
});
