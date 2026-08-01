#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/capability-gates.json"), "utf8"));
const tests = [
  "scripts/test-capability-gate-registry.mjs",
  ...new Set(registry.gates.flatMap((gate) => gate.tests || [])),
];

const failures = [];
for (const testFile of tests) {
  process.stdout.write(`\n[capability-gate] ${testFile}\n`);
  const isElectronTest = testFile.endsWith(".cjs");
  const runtime = isElectronTest ? require("electron") : process.execPath;
  // The dev runtime runs Node itself as electron-as-node (ELECTRON_RUN_AS_NODE
  // is set in this process's env). Node tests (execPath) MUST keep that flag —
  // clearing it would boot Electron as a GUI app and hang. Electron DOM tests
  // are the opposite: with the flag set they boot in node mode and
  // require("electron") is not the built-in API. Clear it only for them.
  const childEnv = isElectronTest
    ? { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    : process.env;
  const result = spawnSync(runtime, [testFile], {
    cwd: ROOT,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.status !== 0) failures.push(testFile);
}

if (failures.length) {
  console.error(`\ncapability-gate: failed (${failures.join(", ")})`);
  process.exit(1);
}

console.log(`\ncapability-gate: ok (${tests.length} tests)`);
