#!/usr/bin/env node
/**
 * Verify bundled runtime exists for the current (or given) platform before dist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function platformCandidates() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return ["darwin-arm64", "darwin-x64"];
    return ["darwin-x64", "darwin-arm64"];
  }
  if (process.platform === "win32") return ["win32-x64"];
  return ["linux-x64"];
}

function detectPlatform() {
  const arg = process.argv.find((a, i) => process.argv[i - 1] === "--platform");
  if (arg) return arg;
  return platformCandidates()[0];
}

function resolveRuntimeRoot() {
  const explicit = process.argv.find((a, i) => process.argv[i - 1] === "--platform");
  const keys = explicit ? [explicit] : platformCandidates();
  for (const platform of keys) {
    const runtimeRoot = path.join(ROOT, "bundles", platform, "runtime");
    const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
    if (fs.existsSync(manifestPath)) return { platform, runtimeRoot, manifestPath };
  }
  return null;
}

function fail(msg) {
  console.error(`[verify-runtime] ${msg}`);
  process.exit(1);
}

const resolved = resolveRuntimeRoot();
if (!resolved) {
  const want = detectPlatform();
  fail(
    `missing bundles/<platform>/runtime — run: npm run build:runtime -- --platform ${want}`,
  );
}

const { platform, runtimeRoot, manifestPath } = resolved;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const venvPython =
  process.platform === "win32"
    ? path.join(runtimeRoot, "venv", "Scripts", "python.exe")
    : path.join(runtimeRoot, "venv", "bin", "python3");

if (!fs.existsSync(venvPython)) {
  fail(`venv python missing at ${venvPython}`);
}

const probe = spawnSync(venvPython, ["-c", "import pandas, openpyxl; print('ok')"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  fail(`venv smoke test failed: ${probe.stderr || probe.stdout}`);
}

if (manifest.platform !== platform) {
  console.warn(
    `[verify-runtime] warning: using bundles/${platform}/runtime but manifest says ${manifest.platform}`,
  );
}

const preferred = platformCandidates()[0];
if (platform !== preferred) {
  console.warn(
    `[verify-runtime] warning: preferred ${preferred} missing; using ${platform} (Rosetta / arch fallback)`,
  );
}

if (!manifest.libreoffice) {
  console.warn("[verify-runtime] warning: LibreOffice not bundled (xlsx formula recalc may fail)");
}

console.log(`[verify-runtime] ok ${platform} python=${manifest.python} lo=${manifest.libreoffice || "none"}`);
