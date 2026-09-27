#!/usr/bin/env node
// Selected models are listed FIRST when the picker opens, so a selected model
// scrolled below the fold is never mistaken for "not selected" (2026-09-27: an
// auto pool of [claude, deepseek] looked like deepseek-only because claude sat
// below the fold). The order is frozen while the popover is open.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../src/renderer/modules/model-picker.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/export /g, "");
const ctx = vm.createContext({ $: () => null, store: { get() {}, on() {} }, document: { addEventListener() {} }, showToast() {}, t: k => k, onLocaleChange() {}, window: { addEventListener() {} } });
vm.runInContext(`${source}\nglobalThis.api = { selectedFirst, orderedModels, setState: s => { state = s; }, resetOrder: () => { displayOrder = null; } };`, ctx);
const ids = (list) => JSON.parse(JSON.stringify(list.map(m => m.id)));
const models = ["daypop-ds", "daypop-qw", "gs-deepseek", "gs-qwen", "gpt", "claude"].map(id => ({ id, label: id, modelID: id }));
ctx.api.setState({ loaded: true, models, selection: { mode: "auto", autoModelIds: ["gs-deepseek", "claude"], manualModelId: "gs-qwen" } });
ctx.api.resetOrder();
const auto = ids(ctx.api.orderedModels("auto"));
assert.deepEqual(auto.slice(0, 2), ["gs-deepseek", "claude"], "every selected model is at the top, in catalog order");
assert.deepEqual(auto.slice(2), ["daypop-ds", "daypop-qw", "gs-qwen", "gpt"], "the rest keep catalog order");
assert.equal(ctx.api.orderedModels("manual")[0].id, "gs-qwen", "manual pick is first");
// frozen while open: toggling a selection does not reorder rows under the pointer
ctx.api.setState({ loaded: true, models, selection: { mode: "auto", autoModelIds: ["gs-deepseek"], manualModelId: "gs-qwen" } });
assert.deepEqual(ids(ctx.api.orderedModels("auto")), auto, "order is frozen until the popover reopens");
ctx.api.resetOrder();
assert.equal(ids(ctx.api.orderedModels("auto"))[0], "gs-deepseek");
assert.equal(ctx.api.orderedModels("auto").length, models.length, "no model is dropped");
console.log("model-picker-order: ok");
