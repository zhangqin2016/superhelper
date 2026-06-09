#!/usr/bin/env node
/**
 * Build macOS auto-update zip with ditto.
 *
 * electron-builder uses bundled 7za for mac zip targets. With the embedded
 * runtime our .app is large enough that 7za can be terminated on Apple Silicon.
 * ditto is the native macOS packaging path and preserves app metadata.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function fail(message) {
  console.error(`[build-mac-zip] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed (exit ${result.status ?? "signal"})`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return String(result.stdout || "").trim();
}

function requestedArch() {
  const idx = process.argv.indexOf("--arch");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.arch === "arm64" ? "arm64" : "x64";
}

function findMacApp(arch, productName) {
  const rel = arch === "arm64" ? "dist/mac-arm64" : "dist/mac";
  const appPath = path.join(ROOT, rel, `${productName}.app`);
  if (fs.existsSync(appPath)) return appPath;
  fail(`No ${productName}.app found for ${arch} under ${rel}`);
}

function assertAppArch(appPath, arch, productName) {
  const binaryPath = path.join(appPath, "Contents", "MacOS", productName);
  if (!fs.existsSync(binaryPath)) {
    fail(`App executable not found: ${path.relative(ROOT, binaryPath)}`);
  }
  const actual = runCapture("lipo", ["-archs", binaryPath]).split(/\s+/).filter(Boolean);
  const expected = arch === "arm64" ? "arm64" : "x86_64";
  if (!actual.includes(expected)) {
    fail(`Expected ${path.relative(ROOT, binaryPath)} to include ${expected}, got ${actual.join(", ") || "unknown"}`);
  }
  if (actual.length > 1) {
    fail(`Expected single-arch ${expected} app for ${arch}, got universal binary: ${actual.join(", ")}`);
  }
}

const pkg = readPkg();
const productName = pkg.build?.productName || pkg.name;
const version = pkg.version;
const arch = requestedArch();
const appPath = findMacApp(arch, productName);
const outPath = path.join(ROOT, "dist", `${productName}-${version}-${arch}.zip`);
const blockmapPath = `${outPath}.blockmap`;

if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
if (fs.existsSync(blockmapPath)) fs.unlinkSync(blockmapPath);
assertAppArch(appPath, arch, productName);

console.log(`[build-mac-zip] creating dist/${path.basename(outPath)} from ${path.relative(ROOT, appPath)}`);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, outPath]);
console.log(`[build-mac-zip] done: ${outPath}`);
