#!/usr/bin/env node
/**
 * Check if win32-x64 runtime exists; cross-build it from macOS if missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_ROOT = path.join(ROOT, "bundles", "win32-x64", "runtime");
const MANIFEST = path.join(RUNTIME_ROOT, "runtime-manifest.json");
const VENV_PYTHON = path.join(RUNTIME_ROOT, "venv", "Scripts", "python.exe");

if (fs.existsSync(MANIFEST) && fs.existsSync(VENV_PYTHON)) {
  console.log("[ensure-win-runtime] Windows runtime already exists, skipping");
  process.exit(0);
}

console.log("[ensure-win-runtime] Windows runtime not found, cross-building...");
const { spawnSync } = await import("node:child_process");
const result = spawnSync(
  process.execPath,
  ["scripts/build-runtime-bundle.mjs", "--platform", "win32-x64"],
  { cwd: ROOT, stdio: "inherit" },
);

if (result.status !== 0) {
  console.warn("[ensure-win-runtime] Cross-build failed — Windows package will lack Python runtime");
  process.exit(0); // Allow build to continue without runtime
}
