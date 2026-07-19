#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/capability-gates.json"), "utf8"));
const tests = [
  "scripts/test-capability-gate-registry.mjs",
  ...new Set(registry.gates.flatMap((gate) => gate.tests || [])),
];

const failures = [];
for (const testFile of tests) {
  process.stdout.write(`\n[capability-gate] ${testFile}\n`);
  const result = spawnSync(process.execPath, [testFile], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) failures.push(testFile);
}

if (failures.length) {
  console.error(`\ncapability-gate: failed (${failures.join(", ")})`);
  process.exit(1);
}

console.log(`\ncapability-gate: ok (${tests.length} tests)`);
