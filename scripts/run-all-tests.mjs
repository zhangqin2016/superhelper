#!/usr/bin/env node
// Runs every command in a package.json script chain ("a && b && c") to
// completion and reports ALL failures, instead of stopping at the first one
// the way the shell && chain does. Usage:
//   node scripts/run-all-tests.mjs [chainScriptName]   (default: test:unit:chain)
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const chainName = process.argv[2] || "test:unit:chain";
const chain = pkg.scripts?.[chainName];
if (!chain) {
  console.error(`No script named "${chainName}" in package.json`);
  process.exit(2);
}

const commands = chain.split("&&").map((part) => part.trim()).filter(Boolean);
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
