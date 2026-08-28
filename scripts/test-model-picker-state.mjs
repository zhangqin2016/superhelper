import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";

const source = fs.readFileSync(new URL("../src/renderer/modules/model-picker.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/export /g, "");
const models = [{ id: "one", label: "One", modelID: "one" }, { id: "two", label: "Two", modelID: "two" }];
const selectionFor = id => ({ mode: "manual", manualModelId: id === "first" ? "one" : "two", autoModelIds: ["one", "two"] });
const listeners = new Map();
const element = { addEventListener() {}, removeAttribute() {}, setAttribute() {} };
let active = "first";
let release;
let delayFirst = true;
const blocked = new Promise(resolve => release = resolve);
const context = vm.createContext({
  $: id => id === "modelSelectionPopover" ? null : element,
  store: { get: () => active, on: (key, listener) => listeners.set(key, listener) },
  document: { addEventListener() {} },
  showToast() {}, t: key => key, onLocaleChange() {},
  window: {
    addEventListener() {},
    assistantClient: {
      async listModelSelection(id) {
        if (delayFirst && id === "first") await blocked;
        return { ok: true, models, selection: selectionFor(id) };
      },
    },
  },
});
vm.runInContext(`${source}\nglobalThis.picker = { initModelPicker, getModelSelectionSnapshot };`, context);
context.picker.initModelPicker();
const sending = context.picker.getModelSelectionSnapshot("first");
active = "second";
listeners.get("activeSessionId")(active);
await context.picker.getModelSelectionSnapshot("second");
delayFirst = false;
release();
assert.equal((await sending)?.manualModelId, "one", "a send already addressed to first must not inherit second's model after an awaited load");
assert.equal((await context.picker.getModelSelectionSnapshot("second")).manualModelId, "two");
console.log("model-picker-state: ok");

function failureHarness(selection, failureMode, initiallyLoaded = false, saveResult = true) {
  let scope = "first";
  let fail = !initiallyLoaded;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let completeSave;
  const saveWaiting = new Promise(resolve => { completeSave = resolve; });
  let persisted = selection;
  const callbacks = new Map();
  const ctx = vm.createContext({
    $: id => id === "modelSelectionPopover" ? null : element,
    store: { get: () => scope, on: (key, listener) => callbacks.set(key, listener) },
    document: { addEventListener() {} }, showToast() {}, t: key => key, onLocaleChange() {},
    window: { addEventListener() {}, assistantClient: {
      async listModelSelection(id) {
        if (id === "second") return { ok: true, models, selection: selectionFor(id) };
        if (fail) {
          await waiting;
          if (failureMode === "throw") throw Error("catalog offline");
          return { ok: false, error: "MODEL_CATALOG_UNAVAILABLE" };
        }
        return { ok: true, models, selection: persisted };
      },
      async setModelSelection(next) {
        await saveWaiting;
        if (!saveResult) throw Error("save rejected");
        persisted = next;
        return { ok: true, selection: persisted };
      },
    } },
  });
  vm.runInContext(`${source}\nglobalThis.picker = { initModelPicker, getModelSelectionSnapshot, loadModels,
    select: selection => { state.selection = selection; return saveSelection(); } };`, ctx);
  ctx.picker.initModelPicker();
  return { picker: ctx.picker, release, completeSave,
    fail: () => { fail = true; },
    switchToSecond: () => { scope = "second"; callbacks.get("activeSessionId")(scope); } };
}

for (const succeeds of [false, true]) {
  for (const background of [false, true]) {
    test(`snapshot waits for ${succeeds ? "successful" : "failed"} preference save (${background ? "background" : "active"})`, async () => {
      const original = { mode: "manual", manualModelId: "one", autoPoolMode: "recommended", autoModelIds: [] };
      const next = { mode: "auto", manualModelId: "", autoPoolMode: "custom", autoModelIds: ["two"] };
      const h = failureHarness(original, "result", true, succeeds);
      await h.picker.getModelSelectionSnapshot("first");
      const saving = h.picker.select(next);
      let resolved = false;
      const pending = h.picker.getModelSelectionSnapshot("first").then(value => { resolved = true; return value; });
      if (background) h.switchToSecond();
      await Promise.resolve();
      assert.equal(resolved, false, "an optimistic choice must not escape before persistence completes");
      h.completeSave();
      await saving;
      assert.deepEqual(JSON.parse(JSON.stringify(await pending)), succeeds ? next : original);
    });
  }
}

test("null renderer snapshots use main's persisted session preference, including restrictive failures", async () => {
  const catalogUrl = new URL("../src/main/model-selection-catalog.js", import.meta.url);
  const nativeRequire = createRequire(catalogUrl);
  let stored;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(catalogUrl, "utf8"), {
    module, process, Buffer,
    require(id) {
      if (id === "./config") return { userDataPath: () => "/virtual/preferences.json" };
      if (id === "node:fs") return { readFileSync: () => JSON.stringify(stored) };
      if (id === "./model-presets") return { listPresetsPublic: () => { throw Error("catalog unavailable"); } };
      if (id === "./remote-config") return {};
      if (id === "./agent-env") return { normalizeToLilyEnv: value => value };
      return nativeRequire(id);
    },
  });
  for (const selection of [
    { mode: "auto", autoPoolMode: "recommended", autoModelIds: [] },
    { mode: "manual", manualModelId: "one" },
    { mode: "auto", autoPoolMode: "custom", autoModelIds: ["one"] },
    { mode: "auto", autoPoolMode: "custom", autoModelIds: [] },
  ]) {
    const h = failureHarness(selection, "throw");
    const pending = h.picker.getModelSelectionSnapshot("first");
    h.switchToSecond();
    h.release();
    const snapshot = await pending;
    assert.equal(snapshot, null);
    stored = { schemaVersion: 1, defaultSelection: { mode: "auto" }, sessions: { first: selection } };
    const route = module.exports.resolveTurnModel({ selection: snapshot, sessionId: "first" });
    assert.equal(route.ok, selection.autoPoolMode === "recommended", "offline recommended Auto alone retains baseline fallback");
    if (!route.ok) assert.equal(route.error, "MODEL_CATALOG_UNAVAILABLE", "manual/custom intent must never widen to the default pool");
  }
});

for (const failureMode of ["result", "throw"]) {
  for (const mode of ["recommended", "manual", "custom"]) {
    const selection = mode === "manual"
      ? { mode, manualModelId: "one", autoPoolMode: "recommended", autoModelIds: [] }
      : { mode: "auto", autoPoolMode: mode, autoModelIds: mode === "custom" ? ["one"] : [], manualModelId: "" };
    for (const background of [false, true]) {
      test(`${failureMode}/${mode}: ${background ? "background" : "active"} load failure delegates to main persisted preference`, async () => {
        const h = failureHarness(selection, failureMode);
        const pending = h.picker.getModelSelectionSnapshot("first");
        if (background) h.switchToSecond();
        h.release();
        assert.equal(await pending, null, "failure must not cancel sending or synthesize a broader model pool");
        if (background) assert.equal((await h.picker.getModelSelectionSnapshot("second")).manualModelId, "two");
      });

      test(`${failureMode}/${mode}: failed refresh cannot override main with stale confirmed ${background ? "background" : "active"} preference`, async () => {
        const h = failureHarness(selection, failureMode, true);
        const snapshot = await h.picker.getModelSelectionSnapshot("first");
        assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), selection);
        h.fail();
        const refresh = h.picker.loadModels(true);
        const pending = h.picker.getModelSelectionSnapshot("first");
        if (background) h.switchToSecond();
        h.release();
        await refresh;
        assert.equal(await pending, null, "main's current persisted selection remains authoritative when refresh fails");
      });
    }
  }
}
