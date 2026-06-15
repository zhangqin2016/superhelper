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
  return candidates
    .flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".app"))
        .map((app) => path.join(dir, app)),
    )
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

const appPath = findMacUnpacked();
if (!appPath) {
  fail("未找到 dist/mac*/…/*.app，请先运行 dist:mac 或 electron-builder --mac --dir");
}

const resources = path.join(appPath, "Contents", "Resources");
if (!fs.existsSync(resources)) {
  fail(`缺少 Contents/Resources: ${appPath}`);
}

const appArch = appPath.includes("mac-arm64") ? "arm64" : "x64";
const bundlesRoot = path.join(resources, "bundles");
if (fs.existsSync(bundlesRoot)) {
  const forbiddenBundle = appArch === "arm64" ? "darwin-x64" : "darwin-arm64";
  if (fs.existsSync(path.join(bundlesRoot, forbiddenBundle))) {
    fail(`${appArch} Mac 包不应包含 bundles/${forbiddenBundle}`);
  }
  const activeBundle = appArch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const libreOfficePath = path.join(bundlesRoot, activeBundle, "runtime", "libreoffice");
  if (fs.existsSync(libreOfficePath)) {
    fail("Mac 包不应内置 LibreOffice；Office 能力统一通过运行时包按需安装");
  }
}

const imgRoot = path.join(resources, "app.asar.unpacked", "node_modules", "@img");
if (fs.existsSync(imgRoot)) {
  const sharpNodes = fs
    .readdirSync(imgRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^sharp-darwin-/.test(entry.name))
    .map((entry) => path.join(imgRoot, entry.name, "lib", `${entry.name}.node`))
    .filter((file) => fs.existsSync(file));
  if (!sharpNodes.length) {
    fail("缺少 sharp darwin 原生包，图片压缩主路径在 Mac 上不可用");
  }
  for (const entry of fs.readdirSync(imgRoot)) {
    if (/^sharp-(win32|linux)-/.test(entry) || /^sharp-libvips-linux-/.test(entry)) {
      fail(`Mac 包不应包含 ${entry}`);
    }
  }
} else {
  fail("缺少 app.asar.unpacked/node_modules/@img，sharp 原生包未打入 Mac 包");
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
