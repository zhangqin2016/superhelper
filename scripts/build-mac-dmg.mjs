#!/usr/bin/env node
/**
 * Build macOS DMG with APFS via hdiutil.
 *
 * electron-builder's bundled dmgbuild (HFS+) can produce incomplete DMGs on
 * macOS 26+ for large apps — Electron Framework.framework may be missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function fail(msg) {
  console.error(`[build-mac-dmg] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? "signal"})`);
  }
}

function findMacApp(archArg) {
  const pkg = readPkg();
  const productName = pkg.build?.productName || pkg.name;
  const candidates = archArg === "arm64"
    ? ["dist/mac-arm64", "dist/mac"]
    : archArg === "x64"
      ? ["dist/mac", "dist/mac-arm64"]
      : ["dist/mac", "dist/mac-arm64", "dist/mac-universal"];

  for (const rel of candidates) {
    const appPath = path.join(ROOT, rel, `${productName}.app`);
    if (fs.existsSync(appPath)) {
      const arch = rel.includes("arm64") ? "arm64" : "x64";
      return { appPath, arch, productName, version: pkg.version };
    }
  }
  fail(`No .app found under dist/mac* — run electron-builder --mac first`);
}

function archFlag(arch) {
  const idx = process.argv.indexOf("--arch");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return arch;
}

const archArg = process.argv.includes("--arch")
  ? process.argv[process.argv.indexOf("--arch") + 1]
  : undefined;

const { appPath, arch, productName, version } = findMacApp(archArg);
const resolvedArch = archFlag(arch);
const outName = `${productName}-${version}-${resolvedArch}.dmg`;
const outPath = path.join(ROOT, "dist", outName);
const volName = `${productName}-${version}`.replace(/\s+/g, "-");

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lily-dmg-"));
const stagedApp = path.join(staging, path.basename(appPath));

try {
  console.log(`[build-mac-dmg] staging ${appPath}`);
  run("ditto", [appPath, stagedApp]);
  fs.symlinkSync("/Applications", path.join(staging, "Applications"));

  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  console.log(`[build-mac-dmg] creating APFS DMG → dist/${outName}`);
  run("hdiutil", [
    "create",
    "-volname",
    volName,
    "-srcfolder",
    staging,
    "-ov",
    "-format",
    "UDZO",
    "-fs",
    "APFS",
    outPath,
  ]);

  console.log(`[build-mac-dmg] done: ${outPath}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
