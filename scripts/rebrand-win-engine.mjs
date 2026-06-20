#!/usr/bin/env node
// Strip any "claude" branding from the Windows engine binary's PE version
// resource (ProductName / FileDescription / OriginalFilename / InternalName) so
// it surfaces only as Lily Workbench in Task Manager — combined with the
// install-time rename to lily-workbench.exe, nothing named "claude" is visible.
//
// No-op off win32. Run on a Windows runner after copying the engine binary into
// bundles/win32-x64/engine-upstream.exe.
//
//   node scripts/rebrand-win-engine.mjs [path-to-engine.exe]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] || path.join(ROOT, "bundles", "win32-x64", "engine-upstream.exe");

if (process.platform !== "win32") {
  console.log(`[rebrand-win-engine] skip (not win32): ${path.relative(ROOT, target)}`);
  process.exit(0);
}
if (!fs.existsSync(target)) {
  console.error(`[rebrand-win-engine] engine binary not found: ${target}`);
  process.exit(1);
}

const res = spawnSync(
  "npx",
  [
    "--yes", "rcedit", target,
    "--set-version-string", "ProductName", "Lily Workbench",
    "--set-version-string", "FileDescription", "Lily Workbench Engine",
    "--set-version-string", "CompanyName", "Lily Workbench",
    "--set-version-string", "InternalName", "lily-workbench",
    "--set-version-string", "OriginalFilename", "lily-workbench.exe",
  ],
  { stdio: "inherit", shell: true },
);
if (res.status !== 0) {
  console.error("[rebrand-win-engine] rcedit failed");
  process.exit(res.status || 1);
}
console.log(`[rebrand-win-engine] ok — version resource rebranded: ${path.relative(ROOT, target)}`);
