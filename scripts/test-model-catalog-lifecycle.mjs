import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { buildEnvManagedClientConfig } from "../server/src/services/client-config.js";

function isolated(name, mocks = {}) {
  const file = new URL(`../src/main/${name}`, import.meta.url);
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout, queueMicrotask,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
  }, { filename: file.pathname });
  return module.exports;
}

function fixture() {
  let active = "A", status = "ready";
  const presets = ["A", "B"].map(id => ({ id, model: `model-${id}`, label: id, custom: false,
    env: { LILY_MODEL: `model-${id}`, LILY_API_BASE_URL: `https://${id.toLowerCase()}.test/v1`,
      LILY_API_KEY: "fixture-only-key", LILY_OPENCODE_PROTOCOL: "openai", LILY_OPENCODE_PROVIDER_ID: "lily" } }));
  const remote = {
    getRemoteModelCatalogSync: () => status === "ready" ? { presets } : null,
    getRemoteModelCatalogStateSync: () => ({ status, catalog: status === "ready" ? { presets } : null }),
    getRemoteModelIdentityAliasesSync: () => ({}),
    getRemoteRuntimeEnvSync: () => ({}),
  };
  const catalog = isolated("model-selection-catalog.js", {
    "node:fs": { readFileSync: () => "null" }, "./config": { userDataPath: () => "/virtual/model-selection.json" },
    "./model-presets": { listPresetsPublic: () => ({ activePresetId: active, presets }) },
    "./spawn-env": { resolveLilyEnv: () => presets.find(p => p.id === active)?.env || {} },
    "./agent-settings": { loadSettingsEnv: () => ({}) }, "./remote-config": remote,
  });
  const runtime = isolated("turn-model-runtime.js", {
    "./model-selection-catalog": catalog, "./session-memory": { readSessionSummary: () => null },
  });
  return { catalog, runtime, presets, setActive: id => active = id, setStatus: value => status = value };
}

test("same model connection survives global-default changes and rejects endpoint replacement", () => {
  const f = fixture();
  const first = f.catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: "B" } });
  const receipt = f.runtime.routeTrace(first);
  f.setActive("B");
  const recover = () => f.runtime.resolveTurnModel({ sourceTurnId: "original" }, "retry", [], {
    sessionId: "s", manager: { getTurnInputByTurnId: () => ({ sessionId: "s", metadata: { modelRoute: receipt } }) },
  });
  const second = recover();
  assert.equal(second.ok, true);
  assert.equal(second.model.providerID, first.model.providerID);
  f.presets[1].env.LILY_API_BASE_URL = "https://replacement.test/v1";
  assert.equal(recover().error, "MODEL_SNAPSHOT_UNAVAILABLE");
});

test("expired selection refreshes before rejection, once, without widening the selection", async () => {
  const f = fixture(); f.setStatus("stale");
  let refreshed = 0;
  const { TurnOrchestrator } = isolated("turn-orchestrator.js", {
    "./turn-model-runtime": f.runtime,
    "./ipc-utils": {
      diagnoseSendBlocker: (_ctx, _id, opts) => {
        assert.equal(opts.modelExecution.model.modelID, "model-B");
        return { error: "FIXTURE_AFTER_MODEL_ADMISSION" };
      },
      refreshRemoteConfigForSend: async () => { refreshed++; f.setStatus("ready"); return { ok: true }; },
      ensureSessionRunner() {}, mergeDisplayFileMetadata: x => x,
    },
  });
  const result = await TurnOrchestrator.prototype._startTurn.call({ ctx: { sessionManager: {} }, _state: () => ({}) },
    { id: "s" }, "hello", [], { modelSelection: { mode: "manual", manualModelId: "B" } });
  assert.equal(refreshed, 1);
  assert.equal(result.error, "FIXTURE_AFTER_MODEL_ADMISSION");
});

test("failed catalog refresh and cancellation cannot dispatch or pick another model", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(); f.setStatus("stale");
    let refreshed = 0;
    const { TurnOrchestrator } = isolated("turn-orchestrator.js", {
      "./turn-model-runtime": f.runtime,
      "./ipc-utils": {
        diagnoseSendBlocker: () => { throw Error("must not dispatch an expired profile"); },
        refreshRemoteConfigForSend: async () => { refreshed++; return { ok: false }; },
        ensureSessionRunner: () => { throw Error("must not start an expired profile"); },
      },
    });
    const result = await TurnOrchestrator.prototype._startTurn.call({ ctx: { sessionManager: {} },
      _state: () => ({ startInFlight: { cancelled } }) }, { id: "s" }, "hello", [],
    { modelSelection: { mode: "auto", autoPoolMode: "custom", autoModelIds: ["B"] } });
    assert.equal(refreshed, 1);
    assert.equal(result.error, cancelled ? "TURN_START_ABORTED" : "MODEL_CATALOG_STALE");
  }
});

test("legacy bare selection migrates from its original catalog and never follows a new default", () => {
  const require = createRequire(import.meta.url);
  const { canonicalModelId, legacyAliases, migrateSelection } = require("../src/main/model-identity.js");
  const prefix = "lily-managed:fixture:gateway";
  const old = { id: prefix, env: { LILY_MODEL: "A", LILY_API_BASE_URL: "https://fixture.test", LILY_OPENCODE_PROTOCOL: "openai" } };
  const aliases = legacyAliases([old]);
  const refreshed = legacyAliases([{ ...old, env: { ...old.env, LILY_MODEL: "B" } }], aliases);
  assert.equal(migrateSelection({ mode: "manual", manualModelId: prefix }, refreshed).manualModelId, canonicalModelId(prefix, "A"));
  const collision = legacyAliases([old, { ...old, env: { ...old.env, LILY_MODEL: "B" } }]);
  assert.equal(collision[prefix], null);
  const ambiguous = migrateSelection({ mode: "manual", manualModelId: prefix }, collision);
  assert.equal(ambiguous.manualModelId, prefix, "ambiguous IDs stay invalid, not guessed");
});

test("legacy receipt provider can migrate only with matching recorded connection identity", () => {
  const f = fixture();
  const first = f.catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: "B" } });
  const { createHash } = createRequire(import.meta.url)("node:crypto");
  const receipt = { ...f.runtime.routeTrace(first), identityVersion: undefined,
    providerId: `lily-model-${createHash("sha256").update("B").digest("hex").slice(0, 16)}` };
  const recover = () => f.runtime.resolveTurnModel({ sourceTurnId: "old" }, "retry", [], {
    sessionId: "s", manager: { getTurnInputByTurnId: () => ({ sessionId: "s", metadata: { modelRoute: receipt } }) },
  });
  assert.equal(recover().ok, true);
  receipt.providerId = "unrelated-connection";
  assert.equal(recover().error, "MODEL_SNAPSHOT_UNAVAILABLE");
});

test("explicit disabled or empty catalog cannot execute the legacy connection", () => {
  const f = fixture(); f.presets.forEach(p => p.enabled = false);
  assert.equal(f.catalog.resolveTurnModel({}).ok, false);
  f.presets.length = 0;
  assert.equal(f.catalog.resolveTurnModel({}).ok, false);
  f.setStatus("unavailable");
  assert.equal(f.catalog.resolveTurnModel({}).ok, true, "missing catalog preserves recommended baseline");
  assert.equal(f.catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: "B" } }).ok, false);
});

test("published IDs are stable, collision-resistant and independent of default pointer", () => {
  const provider = { id: "fixture", type: "anthropic", baseUrl: "https://example.test", apiKey: "fixture-key",
    models: ["family/A", "family:A", "B"], model: "family/A" };
  const config = { modelGatewayDefaultProvider: provider.id, modelConfigDeliveryMode: "gateway" };
  const before = buildEnvManagedClientConfig(config, { fixture: provider }).models;
  provider.model = "B";
  const after = buildEnvManagedClientConfig(config, { fixture: provider }).models;
  assert.equal(new Set(before.presets.map(p => p.id)).size, 3);
  for (const preset of before.presets) assert.equal(after.presets.find(p => p.id === preset.id)?.env.LILY_MODEL, preset.env.LILY_MODEL);
  assert.equal(after.presets.find(p => p.id === after.activePresetId).env.LILY_MODEL, "B");
});
