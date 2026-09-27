#!/usr/bin/env node
/**
 * Release preflight gate for dependency/runtime-pack safety.
 *
 * This runs the small, focused checks that protect the slim-client dependency
 * model before publishing a new client or server bundle. Keep it independent of
 * the current user's installed packs so CI/release machines can run it reliably.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function releaseMatrixArgs() {
  const args = ["scripts/test-runtime-pack-release-matrix.mjs", "--strict"];
  const target = String(process.env.LILY_RELEASE_TARGET || "").trim().toLowerCase();
  if (target === "win" || target === "windows" || target === "win32-x64") {
    args.push("--platform", "win32-x64");
  } else if (target === "mac" || target === "darwin") {
    args.push("--platform", "darwin-arm64,darwin-x64");
  }
  if (process.env.LILY_RELEASE_ONLINE_PREFLIGHT === "1") args.push("--online");
  return args;
}

const CHECKS = [
  // First and cheap: electron-builder must be able to read its own arguments.
  ["node", ["scripts/check-node-argv.mjs"]],
  ["node", releaseMatrixArgs()],
  ["node", ["scripts/test-runtime-packs.mjs"]],
  ["node", ["scripts/test-spawn-env-runtime.mjs"]],
  ["node", ["scripts/test-runtime-health.mjs"]],
  ["node", ["scripts/test-runtime-pack-installer.mjs"]],
  ["node", ["scripts/test-runtime-pack-ipc-runner-refresh.mjs"]],
  ["node", ["scripts/test-runtime-pack-preflight.mjs"]],
  ["node", ["scripts/test-runtime-pack-settings-ui.mjs"]],
  ["node", ["scripts/test-common-runtime-pack-publisher.mjs"]],
];

// A test never touches the developer's real user-data store. The shell Lily's
// own agent runs in hands every subprocess LILY_USER_DATA_DIR = the live
// directory, so a preflight test would read (or worse, write) the live
// runtime-pack state instead of its mocked/isolated path. An inherited
// LILY_USER_DATA_DIR is never passed through; a deliberate one is spelled
// LILY_TEST_USER_DATA_DIR. Everything else (LILY_RELEASE_TARGET, the online
// preflight flag, etc.) passes through unchanged.
function isolatedEnv() {
  const { LILY_USER_DATA_DIR: _inherited, ...baseEnv } = process.env || {};
  if (baseEnv.LILY_TEST_USER_DATA_DIR) {
    baseEnv.LILY_USER_DATA_DIR = baseEnv.LILY_TEST_USER_DATA_DIR;
  }
  return baseEnv;
}

function run(command, args) {
  console.log(`[release-preflight] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: isolatedEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

try {
  for (const [command, args] of CHECKS) run(command, args);
  console.log("[release-preflight] ok");
} catch (error) {
  console.error(`[release-preflight] failed: ${error?.message || error}`);
  process.exit(1);
}
