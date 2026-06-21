#!/usr/bin/env node
/**
 * Fetch the prebuilt OpenCode engine binary (npm package `opencode-ai`) and place
 * it where bundle-locator.findBundledOpencodeBinary() looks:
 *   bundles/<platform-key>/opencode/bin/opencode
 *
 *   node scripts/fetch-opencode-engine.mjs [version] [--platform darwin-arm64]
 *
 * Defaults to the pinned version and the current platform. The npm package ships
 * the platform binary as an optional dep (opencode-<os>-<arch>); we install into
 * a temp dir, then copy the binary into the bundle.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const platIdx = args.indexOf("--platform");
const platArg = platIdx >= 0 ? args[platIdx + 1] : null;
// The positional version arg — but never the value that follows --platform
// (otherwise `--platform darwin-arm64` is misread as version "darwin-arm64").
const version = args.find((a, i) => !a.startsWith("--") && i !== platIdx + 1) || "1.17.8";

// Map our bundle platform key -> the opencode-ai optional-dep package name.
const KEY_TO_PKG = {
  "darwin-arm64": "opencode-darwin-arm64",
  "darwin-x64": "opencode-darwin-x64",
  "linux-x64": "opencode-linux-x64",
  "win32-x64": "opencode-windows-x64",
};
function currentKey() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win32-x64";
  return "linux-x64";
}
const key = platArg || currentKey();
const pkg = KEY_TO_PKG[key];
if (!pkg) { console.error(`Unsupported platform key: ${key}`); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fetch-"));
console.log(`[fetching opencode-ai@${version} (${key}) ...]`);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "ocfetch", private: true }));

// Prefer bun (handles cross-platform optional deps cleanly); fall back to npm.
function install(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { cwd: tmp, stdio: "inherit" });
}
try {
  install("bun", ["add", "--os=*", "--cpu=*", `opencode-ai@${version}`]);
} catch {
  install("npm", ["install", `opencode-ai@${version}`]);
}

const exe = key.startsWith("win32") ? "opencode.exe" : "opencode";
const srcCandidates = [
  path.join(tmp, "node_modules", pkg, "bin", exe),
  path.join(tmp, "node_modules", pkg, "bin", "opencode"),
];
const src = srcCandidates.find((p) => fs.existsSync(p));
if (!src) { console.error(`binary not found for ${pkg}; looked in:\n  ${srcCandidates.join("\n  ")}`); process.exit(1); }

const destDir = path.join(repoRoot, "bundles", key, "opencode", "bin");
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, exe);
fs.copyFileSync(src, dest);
fs.chmodSync(dest, 0o755);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[done] ${path.relative(repoRoot, dest)}`);
