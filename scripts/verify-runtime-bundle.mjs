#!/usr/bin/env node
/**
 * Verify bundled runtime exists for the current (or given) platform before dist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  findExternalRuntimeSymlinks,
  relativizeRuntimeSymlinks,
} from "./fix-runtime-symlinks.mjs";

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

function runtimeRootFor(platform) {
  return path.join(ROOT, "bundles", platform, "runtime");
}

function venvPythonPath(runtimeRoot, platform) {
  if (platform === "win32-x64") {
    return path.join(runtimeRoot, "venv", "Scripts", "python.exe");
  }
  return path.join(runtimeRoot, "venv", "bin", "python3");
}

function isCompleteRuntime(runtimeRoot, platform) {
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  return fs.existsSync(venvPythonPath(runtimeRoot, platform));
}

function resolveRuntimeRoot() {
  const explicit = process.argv.find((a, i) => process.argv[i - 1] === "--platform");
  const keys = explicit ? [explicit] : platformCandidates();
  for (const platform of keys) {
    const runtimeRoot = runtimeRootFor(platform);
    if (isCompleteRuntime(runtimeRoot, platform)) {
      return {
        platform,
        runtimeRoot,
        manifestPath: path.join(runtimeRoot, "runtime-manifest.json"),
      };
    }
  }
  return null;
}

function fail(msg) {
  console.error(`[verify-runtime] ${msg}`);
  process.exit(1);
}

const allowMissing = process.argv.includes("--allow-missing");
const want = detectPlatform();
const partialRoot = runtimeRootFor(want);

for (const platform of platformCandidates()) {
  const runtimeRoot = runtimeRootFor(platform);
  if (!fs.existsSync(runtimeRoot)) continue;
  const { fixed } = relativizeRuntimeSymlinks(runtimeRoot);
  if (fixed > 0) {
    console.log(`[verify-runtime] fixed ${fixed} absolute symlink(s) in ${platform}`);
  }
  const bad = findExternalRuntimeSymlinks(runtimeRoot);
  if (bad.length) {
    fail(
      `invalid symlink(s) in bundles/${platform}/runtime — run: node scripts/fix-runtime-symlinks.mjs --platform ${platform}`,
    );
  }
}

if (fs.existsSync(partialRoot) && !isCompleteRuntime(partialRoot, want)) {
  fail(
    `incomplete bundles/${want}/runtime (missing manifest or venv). ` +
      `Remove it: rm -rf bundles/${want}/runtime — or finish on Windows: ` +
      `npm run build:runtime -- --platform ${want}`,
  );
}

const resolved = resolveRuntimeRoot();
if (!resolved) {
  if (allowMissing) {
    console.warn(
      `[verify-runtime] warning: no bundles/${want}/runtime — Windows 包将不含内置 Python/LibreOffice`,
    );
    console.warn(
      `[verify-runtime] 在 Windows 或 CI 上运行: npm run build:runtime -- --platform ${want}`,
    );
    process.exit(0);
  }
  fail(
    `missing bundles/${want}/runtime — run: npm run build:runtime -- --platform ${want}`,
  );
}

const { platform, runtimeRoot, manifestPath } = resolved;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const venvPython = venvPythonPath(runtimeRoot, platform);

if (!fs.existsSync(venvPython)) {
  fail(`venv python missing at ${venvPython}`);
}

const canRunSmokeTest =
  platform !== "win32-x64" || process.platform === "win32";
if (canRunSmokeTest) {
  const probe = spawnSync(
    venvPython,
    ["-c", "import pandas, openpyxl, pdfplumber, pypdfium2, rapidocr_onnxruntime; print('ok')"],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (probe.status !== 0) {
    const detail = probe.error?.message || probe.stderr || probe.stdout || probe.signal || "unknown error";
    console.warn(`[verify-runtime] warning: venv smoke test failed: ${detail}`);
  }
} else {
  console.warn(
    "[verify-runtime] warning: skipping venv smoke test for win32-x64 on non-Windows host",
  );
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
