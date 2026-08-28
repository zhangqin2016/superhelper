import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Use real composer initialization, store notifications, attachment payloads and
// authoring markers so switching tests exercise the actual draft/file path.
const read = name => fs.readFileSync(new URL(`../src/renderer/modules/${name}.js`, import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/export default store;/g, "").replace(/export /g, "")
  .replace(/\bimport\(/g, "loadModule(");
const plain = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const draft = name => ({
  text: `draft for ${name}`,
  files: [{ id: `${name}-file`, path: `/virtual/${name}.png`, isImage: true, thumbnail: `${name}-preview` }],
  marker: { kind: "characterWorldsAdjustment", adjustmentHandle: `${name}-handle` },
});

function harness(failureMode = "result", blockedStage = "model") {
  const gate = deferred(), entered = deferred();
  const listeners = new Map();
  const input = {
    value: "", dataset: {}, style: {}, scrollHeight: 42,
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
    focus: noop,
  };
  const dispatches = [], previews = [];
  const context = vm.createContext({
    $: id => id === "promptInput" ? input : null,
    window: { innerHeight: 900, assistantClient: {
      async listCommands() { return { ok: true, commands: [] }; },
      async sendMessage(...args) {
        dispatches.push(args);
        if (blockedStage === "dispatch") { entered.resolve(); await gate.promise; }
        if (failureMode === "throw") throw Error("simulated IPC failure");
        return { ok: false, error: "INVALID_MODEL_SELECTION" };
      },
    } },
    document: { createElement: () => ({ replaceChildren: noop }) },
    async loadModule(name) {
      if (name === "./message.js") return { hasPendingUserQuestion: () => false, syncComposerForActiveSession: noop };
      if (name === "./project-tree.js") return { touchSessionUsage: noop };
      throw Error(`Unexpected import: ${name}`);
    },
    setTimeout: () => 0, clearTimeout: noop,
    getTurnPhase: () => "idle", canSend: () => true, subscribeRuntime: noop,
    renderFilePreview: () => previews.push(input.value),
    async getModelSelectionSnapshot() {
      if (blockedStage === "model") { entered.resolve(); await gate.promise; }
      if (blockedStage === "model-reject") {
        entered.resolve(); await gate.promise; throw Error("snapshot rejected");
      }
      return { mode: "manual", manualModelId: "retired-model" };
    },
    t: key => key, showToast: noop,
  });
  vm.runInContext(`${read("state")}\n${read("character-authoring-marker")}\n${read("attachment-payload")}
    function clearPendingFiles() { store.set("pendingFiles", []); renderFilePreview(); }
    ${read("composer-drafts")}
    ${read("composer")}
    globalThis.api = { sendPrompt, initComposer, store, readCharacterAuthoringMarker, clearCharacterAuthoringMarker, restoreCharacterAuthoringMarker };`, context);
  const api = context.api;
  api.store.set("activeSessionId", "A");
  api.store.set("projects", [{}]);
  api.initComposer();
  const type = value => {
    input.value = value.text;
    api.clearCharacterAuthoringMarker(input);
    api.restoreCharacterAuthoringMarker(input, value.marker);
    for (const fn of listeners.get("input") || []) fn();
    api.store.set("pendingFiles", value.files);
  };
  const visible = () => plain({ text: input.value, files: api.store.get("pendingFiles"),
    marker: api.readCharacterAuthoringMarker(input, input.value) });
  return { api, input, gate, entered, dispatches, previews, type, visible,
    client: context.window.assistantClient,
    switchTo: id => api.store.set("activeSessionId", id) };
}

for (const mode of ["result", "throw"]) {
  for (const stage of ["model", "dispatch", "model-reject"]) {
    test(`${mode}/${stage}: failed A restores A text, files and marker without touching B`, { timeout: 2000 }, async () => {
      const h = harness(mode, stage);
      h.type(draft("A"));
      const sending = h.api.sendPrompt();
      await h.entered.promise;
      assert.equal(h.input.value, "");
      h.switchTo("B");
      h.type(draft("B"));
      const previews = h.previews.length;
      h.gate.resolve();
      await sending;
      assert.deepEqual(h.visible(), draft("B"));
      assert.equal(h.previews.length, previews, "background restoration cannot repaint the visible files");
      if (stage !== "model-reject") {
        assert.equal(h.dispatches[0][2], "A");
        assert.equal(h.dispatches[0][4].characterWorldsAdjustmentHandle, "A-handle");
      }
      h.switchTo("A");
      assert.deepEqual(h.visible(), draft("A"));
      h.switchTo("B");
      assert.deepEqual(h.visible(), draft("B"));
    });
  }

  for (const background of [false, true]) {
    for (const newer of ["text", "files", "marker", "cleared"]) {
      test(`${mode}: newer ${newer} draft survives A failure (${background ? "background" : "active"})`, async () => {
        const h = harness(mode);
        h.type(draft("A"));
        const sending = h.api.sendPrompt();
        await h.entered.promise;
        const next = {
          text: newer === "text" ? "new work" : "",
          files: newer === "files" ? draft("new").files : [],
          marker: newer === "marker" ? draft("new").marker : null,
        };
        if (newer === "cleared") h.type(draft("new"));
        h.type(next);
        if (background) { h.switchTo("B"); h.type(draft("B")); }
        h.gate.resolve();
        await sending;
        if (background) h.switchTo("A");
        assert.deepEqual(h.visible(), next);
      });
    }
  }

  test(`${mode}: an unchanged active draft restores immediately and survives switching`, async () => {
    const h = harness(mode);
    const original = { ...draft("A"), marker: { kind: "character", starter: "draft for" } };
    h.type(original);
    const sending = h.api.sendPrompt();
    await h.entered.promise;
    h.gate.resolve();
    await sending;
    assert.deepEqual(h.visible(), original);
    h.switchTo("B");
    assert.deepEqual(h.visible(), { text: "", files: [], marker: null });
    h.switchTo("A");
    assert.deepEqual(h.visible(), original);
  });
}

test("normal switching preserves unsent files, text and authoring markers per session", () => {
  const h = harness();
  h.type(draft("A"));
  h.switchTo("B");
  assert.deepEqual(h.visible(), { text: "", files: [], marker: null });
  h.type(draft("B"));
  h.switchTo("A");
  assert.deepEqual(h.visible(), draft("A"));
  h.switchTo("B");
  assert.deepEqual(h.visible(), draft("B"));
});

test("text-only failure restores raw whitespace to its session after switching away and back", async () => {
  const h = harness();
  const original = { text: "  original A text  ", files: [], marker: null };
  h.type(original);
  const pending = h.api.sendPrompt();
  await h.entered.promise;
  h.switchTo("B");
  h.type(draft("B"));
  h.switchTo("A");
  h.gate.resolve();
  await pending;
  assert.deepEqual(h.visible(), original);
  assert.equal(h.dispatches[0][0], original.text.trim());
  h.switchTo("B");
  assert.deepEqual(h.visible(), draft("B"));
});

test("attachment-only failure restores its own previews and not the active session's files", async () => {
  const h = harness("throw");
  const original = { ...draft("A"), text: "", marker: null };
  h.type(original);
  const pending = h.api.sendPrompt();
  await h.entered.promise;
  h.switchTo("B");
  h.type(draft("B"));
  h.gate.resolve();
  await pending;
  assert.deepEqual(h.visible(), draft("B"));
  h.switchTo("A");
  assert.deepEqual(h.visible(), original);
});

for (const secondSucceeds of [false, true]) {
  test(`older send failure cannot resurrect after a newer ${secondSucceeds ? "successful" : "failed"} send`, async () => {
    const h = harness("result", "none");
    const first = deferred(), entered = deferred();
    h.client.sendMessage = async text => {
      if (text === draft("A").text) { entered.resolve(); await first.promise; return { ok: false, error: "OLD_FAILURE" }; }
      return { ok: secondSucceeds, error: "NEW_FAILURE" };
    };
    h.type(draft("A"));
    const pending = h.api.sendPrompt();
    await entered.promise;
    h.type(draft("new"));
    await h.api.sendPrompt();
    first.resolve();
    await pending;
    assert.deepEqual(h.visible(), secondSucceeds ? { text: "", files: [], marker: null } : draft("new"));
  });
}

test("switching during slash expansion never clears or borrows the next session's draft", async () => {
  const h = harness("result", "none");
  const gate = deferred(), entered = deferred();
  h.client.expandCommand = async () => { entered.resolve(); await gate.promise; return { expanded: { prompt: "expanded A" } }; };
  const original = { ...draft("A"), text: "/command" };
  h.type(original);
  const pending = h.api.sendPrompt();
  await entered.promise;
  h.switchTo("B");
  h.type(draft("B"));
  gate.resolve();
  await pending;
  assert.deepEqual(h.visible(), draft("B"));
  assert.equal(h.dispatches[0][0], "expanded A");
  assert.equal(h.dispatches[0][3][0].thumbnail, "A-preview");
  h.switchTo("A");
  assert.deepEqual(h.visible(), original);
});
