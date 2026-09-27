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
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
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
// Hidden test windows still need prompt timer and renderer scheduling. Apply
// this to discovery, benchmarks and curated chains, never product launches.
const commands = (chainName ? chainCommands(chainName) : discoverCommands()).map(command =>
  command.replace(/^npx electron\s+/, "npx electron --disable-background-timer-throttling --disable-renderer-backgrounding "),
);
const failures = [];
const startedAt = Date.now();

// A test never touches the developer's real user-data store. A real Electron
// harness would reach it through `app.getPath("userData")` — on 2026-08-02 one
// wrote fixture rows into it that stayed enabled for seven weeks — so every
// Electron command gets its own throwaway directory. A plain Node test cannot
// reach it (config.js throws without a base path) unless the shell hands one
// over, and the shell Lily's own agent runs in does: spawn-env gives every
// agent subprocess LILY_USER_DATA_DIR = the live directory. On 2026-09-27 a
// suite run from a Lily conversation filled the live model-context-windows.json
// with example.com fixture windows. So an inherited LILY_USER_DATA_DIR is never
// passed through; a deliberate one is spelled LILY_TEST_USER_DATA_DIR.
function isolatedEnv(command) {
  const { LILY_USER_DATA_DIR: inherited, ...baseEnv } = process.env || {};
  if (baseEnv.LILY_TEST_USER_DATA_DIR) return { ...baseEnv, LILY_USER_DATA_DIR: baseEnv.LILY_TEST_USER_DATA_DIR };
  if (!command.startsWith("npx electron")) return inherited ? baseEnv : undefined;
  try {
    return { ...baseEnv, LILY_USER_DATA_DIR: mkdtempSync(path.join(tmpdir(), "lily-test-userdata-")) };
  } catch (error) {
    // Without its own directory an Electron test would write the live one.
    console.error(`[run-all-tests] cannot isolate user data for ${command}: ${error?.message || error}`);
    return { ...baseEnv, LILY_USER_DATA_DIR: path.join(tmpdir(), "lily-test-userdata-fallback") };
  }
}

for (const command of commands) {
  const t0 = Date.now();
  const env = isolatedEnv(command);
  try {
    // Force the direct shell to stop at the deadline. This is NOT a process-tree
    // kill: npx/Electron descendants may outlive it and need scoped diagnosis.
    execSync(command, { stdio: "pipe", timeout: 180_000, killSignal: "SIGKILL", ...(env ? { env } : {}) });
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
