#!/usr/bin/env node
/**
 * Run with: npx electron scripts/test-runtime-node.cjs
 */
const { spawnSync } = require("node:child_process");
const { app } = require("electron");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("../src/main/runtime-node");

function run() {
  ensureRuntimeNodeShim();
  const shim = resolveRuntimeNodePath();
  const result = spawnSync(shim, ["-p", "process.version"], { encoding: "utf8" });

  if (result.error || result.status !== 0) {
    console.error("runtime-node shim failed:", result.error || result.stderr);
    process.exit(1);
  }

  const version = result.stdout.trim();
  const major = Number.parseInt(version.slice(1), 10);
  if (!Number.isFinite(major) || major < 18) {
    console.error("runtime-node shim too old:", version);
    process.exit(1);
  }

  console.log("runtime-node: ok", version);
}

app.whenReady().then(() => {
  run();
  app.quit();
});
