#!/usr/bin/env node
/**
 * After `electron-builder --win --dir`, verify the Windows installer payload.
 *
 * Windows ships the base Python runtime because document/image Python skills
 * and optional runtime packs (Pillow, rembg, pro-pdf, etc.) need a known-good
 * interpreter. Heavy optional runtime-packs still must not be bundled.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsPackSmokeHost } from "./lib/windows-runtime-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = path.join(ROOT, "dist", "win-unpacked");
const bundlesRoot = path.join(unpacked, "resources", "bundles");

function fail(msg) {
  console.error(`[verify-win-pack] ${msg}`);
  process.exit(1);
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}: ${path.relative(ROOT, file)}`);
  }
}

function requireDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`missing ${label}: ${path.relative(ROOT, dir)}`);
  }
}

function forbidPath(target, label) {
  if (fs.existsSync(target)) {
    fail(`must not include ${label}: ${path.relative(ROOT, target)}`);
  }
}

if (!fs.existsSync(unpacked)) {
  fail("dist/win-unpacked does not exist; run dist:win or electron-builder --win --dir first");
}

const forbiddenBundles = ["darwin-arm64", "darwin-x64", "linux-x64"];
for (const name of forbiddenBundles) {
  forbidPath(path.join(bundlesRoot, name), `${name} bundle in Windows package`);
}

const winBundle = path.join(bundlesRoot, "win32-x64");
if (!fs.existsSync(winBundle)) {
  fail("missing resources/bundles/win32-x64");
}

const winEngine = path.join(winBundle, "opencode", "bin", "opencode.exe");
requireFile(winEngine, "OpenCode engine");
const winEngineSize = fs.statSync(winEngine).size;
if (winEngineSize < 5 * 1024 * 1024) {
  fail(`OpenCode engine is suspiciously small (${winEngineSize} bytes)`);
}

const runtimeDir = path.join(winBundle, "runtime");
const runtimeManifestFile = path.join(runtimeDir, "runtime-manifest.json");
const runtimeVenvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
const runtimeSitePackages = path.join(runtimeDir, "venv", "Lib", "site-packages");
const runtimeUv = path.join(runtimeDir, "bin", "uv.exe");
requireFile(runtimeManifestFile, "Windows base runtime manifest");
requireFile(runtimeVenvPython, "Windows venv Python layout");
requireDirectory(runtimeSitePackages, "Windows base runtime site-packages");
requireFile(runtimeUv, "Windows base runtime uv");

const pythonRoot = path.join(runtimeDir, "python");
requireDirectory(pythonRoot, "relocatable Windows base Python");
const pythonInstalls = fs
  .readdirSync(pythonRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^cpython-/i.test(entry.name))
  .map((entry) => path.join(pythonRoot, entry.name));
let runtimePython = "";
for (const installDir of pythonInstalls) {
  for (const candidate of [
    path.join(installDir, "python.exe"),
    path.join(installDir, "python", "python.exe"),
  ]) {
    if (fs.existsSync(candidate)) {
      runtimePython = candidate;
      break;
    }
  }
  if (runtimePython) break;
}
if (!runtimePython) fail(`missing relocatable Windows base Python under ${path.relative(ROOT, pythonRoot)}`);

let runtimeManifest = null;
try {
  runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestFile, "utf8"));
} catch (err) {
  fail(`runtime-manifest.json is not valid JSON: ${String(err?.message || err)}`);
}
if (runtimeManifest.platform !== "win32-x64") {
  fail(`runtime manifest platform must be win32-x64, got ${runtimeManifest.platform}`);
}
if (!runtimeManifest.python) {
  fail("runtime manifest must declare a python version");
}

forbidPath(path.join(runtimeDir, "libreoffice"), "incomplete base LibreOffice runtime");
forbidPath(path.join(winBundle, "runtime-packs"), "bundled runtime-packs");
forbidPath(
  path.join(runtimeDir, "bin", "python.exe"),
  "invalid runtime/bin Python executable shadow",
);
forbidPath(
  path.join(runtimeDir, "bin", "python3.exe"),
  "invalid runtime/bin Python executable shadow",
);

try {
  assertWindowsPackSmokeHost(process.platform);
} catch (error) {
  fail(error?.message || String(error));
}
const smokeEnv = {
  ...process.env,
  PATH: [
    path.join(runtimeDir, "bin"),
    path.dirname(runtimePython),
    path.dirname(runtimeVenvPython),
    process.env.PATH || "",
  ].filter(Boolean).join(path.delimiter),
  PYTHONPATH: [
    runtimeSitePackages,
    process.env.PYTHONPATH || "",
  ].filter(Boolean).join(path.delimiter),
};
try {
  execFileSync(
    "python.exe",
    [
      "-c",
      "import docx, docxtpl, openpyxl, pandas, pdfplumber, pptx, pypdfium2, rapidocr_onnxruntime, reportlab; print('ok')",
    ],
    {
      encoding: "utf8",
      env: smokeEnv,
      timeout: 120_000,
      windowsHide: true,
    },
  );
} catch (error) {
  const detail = error?.stderr || error?.stdout || error?.message || String(error);
  fail(`packaged Windows base runtime smoke test failed: ${String(detail).trim()}`);
}

const sharpNode = path.join(
  unpacked,
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "@img",
  "sharp-win32-x64",
  "lib",
  "sharp-win32-x64.node",
);
requireFile(sharpNode, "sharp win32-x64 native package");

const imgRoot = path.join(unpacked, "resources", "app.asar.unpacked", "node_modules", "@img");
if (fs.existsSync(imgRoot)) {
  for (const entry of fs.readdirSync(imgRoot)) {
    if (/^sharp-(darwin|linux)-/.test(entry) || /^sharp-libvips-(darwin|linux)-/.test(entry)) {
      fail(`Windows package must not include @img/${entry}`);
    }
  }
}

const napiRoot = path.join(unpacked, "resources", "app.asar.unpacked", "node_modules", "@napi-rs");
if (fs.existsSync(napiRoot)) {
  for (const entry of fs.readdirSync(napiRoot)) {
    if (/-(darwin|linux)(-|$)/.test(entry)) {
      fail(`Windows package must not include @napi-rs/${entry}`);
    }
  }
}

let fileCount = 0;
let totalBytes = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else {
      fileCount += 1;
      totalBytes += fs.statSync(full).size;
    }
  }
}
walk(unpacked);

try {
  execFileSync(process.execPath, ["scripts/purge-macos-junk.mjs", "--verify", unpacked], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  fail("Windows package contains macOS metadata such as __MACOSX or .DS_Store");
}

const mb = (totalBytes / (1024 * 1024)).toFixed(0);
console.log(
  `[verify-win-pack] ok - ${fileCount} files, ~${mb} MB unpacked, win32-x64 engine + base Python runtime present`,
);
