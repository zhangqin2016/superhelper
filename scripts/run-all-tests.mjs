#!/usr/bin/env node
// Test runner with convention-based discovery. Default mode runs every test in
// scripts/ — no package.json registration needed, so a test file can never be
// silently orphaned:
//   scripts/test-*.mjs  → node
//   scripts/test-*.cjs  → npx electron   (renderer/electron-API tests)
// plus the benchmark regressions listed in BENCH_COMMANDS.
//
// Every command runs to completion and ALL failures are reported, instead of
// stopping at the first one the way a shell && chain does.
//
// Usage:
//   node scripts/run-all-tests.mjs                 # discover and run everything
//   node scripts/run-all-tests.mjs test:runtime    # run a curated package.json chain
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

// Benchmarks double as perf regressions but don't match the test-* convention.
const BENCH_COMMANDS = [
  "npx electron scripts/bench-replay-renderer.cjs",
];

function discoverCommands() {
  const files = readdirSync(scriptsDir).sort();
  const commands = [];
  for (const file of files) {
    if (/^test-.*\.mjs$/.test(file)) commands.push(`node scripts/${file}`);
    else if (/^test-.*\.cjs$/.test(file)) commands.push(`npx electron scripts/${file}`);
  }
  return [...commands, ...BENCH_COMMANDS];
}

function chainCommands(chainName) {
  const pkg = require("../package.json");
  const chain = pkg.scripts?.[chainName];
  if (!chain) {
    console.error(`No script named "${chainName}" in package.json`);
    process.exit(2);
  }
  return chain.split("&&").map((part) => part.trim()).filter(Boolean);
}

const chainName = process.argv[2];
const commands = chainName ? chainCommands(chainName) : discoverCommands();
const failures = [];
const startedAt = Date.now();

for (const command of commands) {
  const t0 = Date.now();
  try {
    execSync(command, { stdio: "pipe", timeout: 180_000 });
    console.log(`PASS  ${command}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`;
    failures.push({ command, output: output.slice(-1500) });
    console.log(`FAIL  ${command}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

console.log(`\n${commands.length - failures.length}/${commands.length} passed in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
for (const { command, output } of failures) {
  console.log(`\n=== FAIL: ${command} ===\n${output}`);
}
process.exit(failures.length === 0 ? 0 : 1);
