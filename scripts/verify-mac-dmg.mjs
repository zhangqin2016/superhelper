#!/usr/bin/env node
/**
 * Mount a macOS DMG and verify Electron Framework is present (post-build gate).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function fail(msg) {
  console.error(`[verify-mac-dmg] ${msg}`);
  process.exit(1);
}

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function resolveDmgPath() {
  const explicit = process.argv.find((a, i) => process.argv[i - 1] === "--dmg");
  if (explicit) return path.resolve(explicit);

  const pkg = readPkg();
  const productName = pkg.build?.productName || pkg.name;
  const arch = process.argv.includes("--arch")
    ? process.argv[process.argv.indexOf("--arch") + 1]
    : process.arch === "arm64"
      ? "arm64"
      : "x64";
  return path.join(ROOT, "dist", `${productName}-${pkg.version}-${arch}.dmg`);
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

const dmgPath = resolveDmgPath();
if (!fs.existsSync(dmgPath)) {
  fail(`DMG not found: ${dmgPath}`);
}

const mountPoint = fs.mkdtempSync(path.join("/tmp", "lily-dmg-verify-"));

try {
  const attachOut = runCapture("hdiutil", [
    "attach",
    "-nobrowse",
    "-mountpoint",
    mountPoint,
    dmgPath,
  ]);
  console.log(`[verify-mac-dmg] mounted ${dmgPath}`);

  const apps = fs.readdirSync(mountPoint).filter((n) => n.endsWith(".app"));
  if (apps.length === 0) fail(`No .app in DMG at ${mountPoint}`);

  const frameworkBinary = path.join(
    mountPoint,
    apps[0],
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  );

  if (!fs.existsSync(frameworkBinary)) {
    fail(`Missing Electron Framework binary in DMG: ${frameworkBinary}`);
  }

  const { size } = fs.statSync(frameworkBinary);
  const minBytes = 50 * 1024 * 1024;
  if (size < minBytes) {
    fail(`Electron Framework too small (${size} bytes) — DMG likely incomplete`);
  }

  console.log(
    `[verify-mac-dmg] OK — Electron Framework ${(size / 1024 / 1024).toFixed(1)} MiB`,
  );
} finally {
  spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "inherit" });
  fs.rmSync(mountPoint, { recursive: true, force: true });
}
