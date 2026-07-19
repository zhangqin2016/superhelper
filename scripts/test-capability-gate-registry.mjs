#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/capability-gates.json"), "utf8"));

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

console.log(`capability-gate-registry: ok (${registry.gates.length} gates)`);
