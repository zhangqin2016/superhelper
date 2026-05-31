#!/usr/bin/env node
/**
 * After `electron-builder --mac --dir`, ensure no macOS junk shipped inside the app bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`[verify-mac-pack] ${msg}`);
  process.exit(1);
}

function findMacUnpacked() {
  const dist = path.join(ROOT, "dist");
  if (!fs.existsSync(dist)) return null;
  const candidates = fs
    .readdirSync(dist, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^mac(-|$)/.test(e.name))
    .map((e) => path.join(dist, e.name));
  for (const dir of candidates) {
    const apps = fs.readdirSync(dir).filter((n) => n.endsWith(".app"));
    if (apps.length) return path.join(dir, apps[0]);
  }
  return null;
}

const appPath = findMacUnpacked();
if (!appPath) {
  fail("未找到 dist/mac*/…/*.app，请先运行 dist:mac 或 electron-builder --mac --dir");
}

const resources = path.join(appPath, "Contents", "Resources");
if (!fs.existsSync(resources)) {
  fail(`缺少 Contents/Resources: ${appPath}`);
}

try {
  execFileSync(
    process.execPath,
    ["scripts/purge-macos-junk.mjs", "--verify", resources],
    { cwd: ROOT, stdio: "inherit" },
  );
} catch {
  fail("Mac 安装包 Resources 内含有 __MACOSX / .DS_Store 等元数据");
}

console.log(`[verify-mac-pack] ok — ${path.relative(ROOT, appPath)}`);
