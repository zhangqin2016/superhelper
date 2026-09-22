#!/usr/bin/env node
// Delivery is a pipeline of individually fail-safe stages: when something is
// missing each one keeps the previous value rather than shipping an empty menu.
// Together they meant an operator could save a rule, see it listed, and never
// learn that the delivered config dropped it. The pipeline now keeps a receipt,
// and the receipt is produced by DIFFING each stage, so a stage added later is
// covered without remembering to report anything.
// [gate: config-delivery-explainability]
// Run: node scripts/test-config-delivery-provenance.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_provenance_test";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  createDeliveryTrace,
  deepMergeInto,
  leafPaths,
  mergeWithProvenance,
} = await import("../server/src/services/config-delivery-trace.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

const globalRule = { id: "g1", scope: "global", name: "默认", config: { models: { providers: ["deepseek"], activeProvider: "deepseek" }, tools: { search: true } } };
const licenseRule = { id: "l1", scope: "license", name: "daypop", config: { models: { providers: ["daypop"], activeProvider: "daypop" } } };

check("every field remembers which rule established it", () => {
  const { config, provenance } = mergeWithProvenance([globalRule, licenseRule], { schemaVersion: 1 });
  assert.deepEqual(config.models.providers, ["daypop"], "the later rule wins");
  assert.equal(provenance["models.providers"].id, "l1");
  assert.equal(provenance["models.activeProvider"].scope, "license");
  assert.equal(provenance["tools.search"].id, "g1", "a field no later rule touched keeps its author");
  assert.equal(provenance["schemaVersion"], undefined, "the baseline is not a rule");
});

check("merge semantics are unchanged: objects deep-merge, arrays and scalars replace", () => {
  const merged = deepMergeInto({ a: { b: 1, c: 2 }, list: [1, 2, 3] }, { a: { c: 9 }, list: [7] });
  assert.deepEqual(merged, { a: { b: 1, c: 9 }, list: [7] });
  // A stored rule cannot mutate the object it was merged into.
  const source = { nested: { keep: true } };
  const out = deepMergeInto({}, source);
  out.nested.keep = false;
  assert.equal(source.nested.keep, true);
});

check("a stage that drops a field says so, without the stage knowing it must", () => {
  const trace = createDeliveryTrace();
  const merged = trace.merge([globalRule, licenseRule], { schemaVersion: 1 });
  // Exactly the real fail-safe: no provider is configured, so the menu directive
  // is dropped and the baseline menu stands.
  const after = trace.stage("modelMenu", merged, (cfg) => ({ ...cfg, models: { source: "service" } }));
  assert.equal(after.models.providers, undefined);
  const { decisions } = trace.receipt();
  const dropped = decisions.find((d) => d.field === "models.providers");
  assert.equal(dropped.stage, "modelMenu");
  assert.equal(dropped.reason, "removed");
  assert.ok(decisions.some((d) => d.reason === "added" && d.field === "models.source"));
});

check("a rewritten value carries what it was and what it became", () => {
  const trace = createDeliveryTrace();
  const merged = trace.merge([globalRule], {});
  trace.stage("collaborationGate", merged, (cfg) => ({ ...cfg, tools: { search: false } }));
  const rewritten = trace.receipt().decisions.find((d) => d.field === "tools.search");
  assert.equal(rewritten.reason, "rewritten");
  assert.match(rewritten.detail, /true -> false/);
});

check("rules that never applied are on the receipt, except those aimed at somebody else", () => {
  const trace = createDeliveryTrace();
  trace.skipped([
    { id: "off", scope: "global", reason: "disabled" },
    { id: "held", scope: "device", reason: "rollout_withheld" },
    { id: "elsewhere", scope: "license", reason: "target_mismatch" },
  ]);
  const { decisions } = trace.receipt();
  assert.deepEqual(decisions.map((d) => d.rule), ["off", "held"], "a rule addressed to another client is not noise");
});

check("the receipt is bounded, so a pathological config cannot flood a response", () => {
  const trace = createDeliveryTrace({ maxDecisions: 3 });
  const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  trace.stage("wipe", wide, () => ({}));
  assert.equal(trace.receipt().decisions.length, 3);
  assert.deepEqual([...leafPaths({ a: { b: 1 }, c: [1, 2] }).keys()], ["a.b", "c"], "arrays are leaves: delivery replaces them whole");
});

check("delivery wraps its real stages and ships the receipt; the schema declares it", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/src/routes/public/client-config.js"), "utf8");
  for (const stage of ["agentSelection", "collaborationGate", "modelMenu"]) {
    assert.match(src, new RegExp(`trace\\.stage\\("${stage}"`), `${stage} runs inside the trace`);
  }
  assert.match(src, /configProvenance: receipt\.provenance/, "the receipt travels with the config");
  assert.match(src, /configDecisions: receipt\.decisions/);
  assert.match(src, /configProvenance: \{ type: "object"/, "and is declared, or fastify would drop it");
  assert.match(src, /configDecisions: \{ type: "array"/);
  // The receipt explains delivery; it must not become part of what is signed.
  const signed = src.slice(src.indexOf("const payload = {"), src.indexOf("return reply.send("));
  assert.ok(!/configProvenance|configDecisions/.test(signed), "the signed payload is unchanged");
});

check("the admin preview answers with the same receipt", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/config-profiles.js"), "utf8");
  assert.match(src, /const trace = createDeliveryTrace\(\)/);
  assert.match(src, /provenance: receipt\.provenance/);
  assert.match(src, /decisions: receipt\.decisions/);
});

console.log(`\n${checks} checks passed (config delivery provenance)`);
