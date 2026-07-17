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
const runtimePython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
const runtimeUv = path.join(runtimeDir, "bin", "uv.exe");
requireFile(runtimeManifestFile, "Windows base runtime manifest");
requireFile(runtimePython, "Windows base runtime Python");
requireFile(runtimeUv, "Windows base runtime uv");

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
