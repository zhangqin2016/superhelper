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

const CHECKS = [
  ["node", ["scripts/test-runtime-pack-release-matrix.mjs", "--strict"]],
  ["node", ["scripts/test-runtime-packs.mjs"]],
  ["node", ["scripts/test-spawn-env-runtime.mjs"]],
  ["node", ["scripts/test-runtime-health.mjs"]],
  ["node", ["scripts/test-runtime-pack-installer.mjs"]],
  ["node", ["scripts/test-runtime-pack-ipc-runner-refresh.mjs"]],
  ["node", ["scripts/test-runtime-pack-preflight.mjs"]],
  ["node", ["scripts/test-runtime-pack-settings-ui.mjs"]],
  ["node", ["scripts/test-common-runtime-pack-publisher.mjs"]],
];

if (process.env.LILY_RELEASE_ONLINE_PREFLIGHT === "1") {
  CHECKS.unshift(["node", ["scripts/test-runtime-pack-release-matrix.mjs", "--online"]]);
}

function run(command, args) {
  console.log(`[release-preflight] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
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
