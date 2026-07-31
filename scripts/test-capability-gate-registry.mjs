#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/capability-gates.json"), "utf8"));
const capabilityGateDoc = fs.readFileSync(path.join(ROOT, "CAPABILITY-GATE.md"), "utf8");
const docLines = capabilityGateDoc.split("\n");

assert.equal(registry.schemaVersion, 1);
assert(Array.isArray(registry.gates) && registry.gates.length > 0);
const ids = new Set();
for (const gate of registry.gates) {
  assert(gate.id && !ids.has(gate.id), `duplicate or missing capability gate id: ${gate.id}`);
  ids.add(gate.id);
  assert.equal(typeof gate.protects, "string", `${gate.id} protects`);
  assert.equal(typeof gate.baseline, "string", `${gate.id} baseline`);
  assert.equal(typeof gate.failureFallback, "string", `${gate.id} failureFallback`);
  assert(Array.isArray(gate.tests) && gate.tests.length > 0, `${gate.id} must own at least one test`);
  for (const testFile of gate.tests) {
    assert(fs.existsSync(path.join(ROOT, testFile)), `${gate.id} references missing test ${testFile}`);
  }
}

// JSON <-> CAPABILITY-GATE.md linkage: every registered gate id anchors exactly
// one human-readable row (format: `[gate: <id>]` at the end of the row), and
// every guard test the JSON lists must be named in that row (rows cite tests
// as backticked basenames, e.g. `test-turn-orchestrator.mjs`).
const anchors = new Map();
for (const [index, line] of docLines.entries()) {
  for (const match of line.matchAll(/\[gate: ([a-z0-9-]+)\]/g)) {
    const id = match[1];
    assert(!anchors.has(id), `duplicate [gate: ${id}] anchor in CAPABILITY-GATE.md (lines ${anchors.get(id) + 1} and ${index + 1})`);
    anchors.set(id, index);
  }
}
for (const gate of registry.gates) {
  const rowIndex = anchors.get(gate.id);
  assert.notEqual(rowIndex, undefined, `${gate.id} must appear in CAPABILITY-GATE.md as a [gate: ${gate.id}] anchor`);
  const row = docLines[rowIndex];
  for (const testFile of gate.tests) {
    const basename = path.basename(testFile);
    assert(
      row.includes(basename),
      `${gate.id}: CAPABILITY-GATE.md row must list guard test ${basename}`,
    );
  }
}
for (const id of anchors.keys()) {
  assert(ids.has(id), `CAPABILITY-GATE.md anchor [gate: ${id}] has no registry entry`);
}

console.log(`capability-gate-registry: ok (${registry.gates.length} gates, ${anchors.size} doc anchors)`);
