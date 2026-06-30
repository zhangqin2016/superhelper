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
if (!fs.existsSync(bundlesRoot)) {
  fail("完整 Mac 包应包含 resources/bundles");
}

const forbiddenBundle = appArch === "arm64" ? "darwin-x64" : "darwin-arm64";
if (fs.existsSync(path.join(bundlesRoot, forbiddenBundle))) {
  fail(`${appArch} Mac 包不应包含 bundles/${forbiddenBundle}`);
}
const activeBundle = appArch === "arm64" ? "darwin-arm64" : "darwin-x64";
const runtimeRoot = path.join(bundlesRoot, activeBundle, "runtime");
const runtimeManifest = path.join(runtimeRoot, "runtime-manifest.json");
if (!fs.existsSync(runtimeManifest)) {
  fail(`完整 Mac 包应包含内置 runtime，但未找到: ${path.relative(ROOT, runtimeManifest)}`);
}
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(runtimeManifest, "utf8"));
} catch (err) {
  fail(`runtime-manifest.json 无法解析: ${String(err?.message || err)}`);
}
if (!manifest.libreoffice) {
  fail("完整 Mac 包必须内置 LibreOffice，不能让用户首次使用 Office 能力时再下载");
}
const sofficeCandidates = [
  path.join(runtimeRoot, "libreoffice", "LibreOffice.app", "Contents", "MacOS", "soffice"),
  path.join(runtimeRoot, "libreoffice", "program", "soffice"),
  path.join(runtimeRoot, "libreoffice", "opt", "libreoffice", "program", "soffice"),
];
if (!sofficeCandidates.some((candidate) => fs.existsSync(candidate))) {
  fail("runtime-manifest 声明已内置 LibreOffice，但包内找不到 soffice");
}

// The OpenCode engine is excluded from electron-builder signing (signIgnore),
// so dist-mac.sh re-signs it with the hardened-runtime entitlements. If that
// step is missing/broken, macOS SIGKILLs the engine at launch ("Code Signature
// Invalid" → "engine stopped unexpectedly (code null)"). Fail loud here so an
// unrunnable build never ships.
const engine = path.join(bundlesRoot, activeBundle, "opencode", "bin", "opencode");
if (!fs.existsSync(engine)) {
  fail(`缺少 OpenCode 引擎二进制: ${path.relative(ROOT, engine)}`);
}
try {
  execFileSync("codesign", ["--verify", "--strict", engine], { stdio: "pipe" });
} catch (err) {
  fail(
    `OpenCode 引擎签名无效，运行时会被 macOS SIGKILL（hardenedRuntime）。` +
      `dist-mac.sh 的补签步骤未生效：${String(err?.stderr || err?.message || err).trim()}`,
  );
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
