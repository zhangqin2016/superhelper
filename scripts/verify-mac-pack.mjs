#!/usr/bin/env node
/**
 * After `electron-builder --mac --dir`, verify the packaged Mac app bundle.
 *
 * Mac ships the base Python runtime (built natively per-arch) so document/image
 * Python skills work out of the box; LibreOffice + optional runtime-packs stay
 * on-demand.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";

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
  fail("Mac 包应包含 resources/bundles");
}

const forbiddenBundle = appArch === "arm64" ? "darwin-x64" : "darwin-arm64";
if (fs.existsSync(path.join(bundlesRoot, forbiddenBundle))) {
  fail(`${appArch} Mac 包不应包含 bundles/${forbiddenBundle}`);
}
const activeBundle = appArch === "arm64" ? "darwin-arm64" : "darwin-x64";
const activeBundleRoot = path.join(bundlesRoot, activeBundle);
if (!fs.existsSync(activeBundleRoot)) {
  fail(`缺少当前架构 bundle: bundles/${activeBundle}`);
}
// Mac bundles the base Python runtime (built natively per-arch, no cross-build)
// so pillow/opencv/numpy/document parsing work out of the box; LibreOffice +
// optional runtime-packs stay on-demand to bound the dmg size.
const runtimeDir = path.join(activeBundleRoot, "runtime");
const runtimeManifestFile = path.join(runtimeDir, "runtime-manifest.json");
const runtimePython = path.join(runtimeDir, "venv", "bin", "python3");
const runtimeUv = path.join(runtimeDir, "bin", "uv");
if (!fs.existsSync(runtimeManifestFile)) {
  fail(`缺少内置基础 Python 运行时清单：bundles/${activeBundle}/runtime/runtime-manifest.json。先运行 \`npm run build:runtime\`（在 ${appArch} Mac 上）生成运行时再打包。`);
}
if (!fs.existsSync(runtimePython)) {
  fail(`缺少内置基础 Python：bundles/${activeBundle}/runtime/venv/bin/python3（客户端无 Python 会导致 pillow/文档处理等全部不可用）。`);
}
if (!fs.existsSync(runtimeUv)) {
  fail(`缺少内置 uv：bundles/${activeBundle}/runtime/bin/uv。`);
}
if (fs.existsSync(path.join(runtimeDir, "libreoffice"))) {
  fail(`默认 Mac 包不应内置 incomplete base LibreOffice runtime（体积过大）；它应通过设置页按需下载。请从打包中排除 runtime/libreoffice。`);
}
if (fs.existsSync(path.join(activeBundleRoot, "runtime-packs"))) {
  fail(`默认 Mac 安装包不应内置 bundled runtime-packs；可选依赖请通过设置页按需安装。`);
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

// 前台包装进程：POSIX 上引擎不再由主进程直接 spawn，而是先起
// src/main/collaboration/foreground-launcher.js（asar 内），由它登记自己的进程组
// 再拉起引擎。这一层只在打包后才可能失效——脚本在 asar 里、要用包内 Electron 以
// ELECTRON_RUN_AS_NODE 执行、并且依赖包内 Node 的 node:sqlite。开发树跑得通不代表
// 安装包跑得通，而它失效的后果是引擎起不来，也就是整个对话不可用。
// Windows 不走这条路径（无进程组语义，仍是普通 spawn），故不在此校验。
{
  const electronBin = fs
    .readdirSync(path.join(appPath, "Contents", "MacOS"))
    .map((name) => path.join(appPath, "Contents", "MacOS", name))
    .find((file) => fs.statSync(file).isFile());
  if (!electronBin) fail("缺少 Contents/MacOS 可执行文件，无法验证前台包装脚本");
  const launcher = path.join(resources, "app.asar", "src", "main", "collaboration", "foreground-launcher.js");
  // 真实路径：macOS 的 /var/folders 是 /private/var 的软链接，而协调文件会拒绝
  // realpath 与自身不一致的目录（UNSAFE_PATH）。
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-foreground-verify-")));
  const marker = "lily-foreground-ok";
  try {
    const result = spawnSync(electronBin, [launcher], {
      // 与生产完全一致：detached 让它成为进程组组长，命令经 stdin 传入而非命令行。
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      input: JSON.stringify({
        command: "/bin/sh",
        args: ["-c", `printf %s ${marker}`],
        cwd: scratch,
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
        shell: false,
        filePath: path.join(scratch, "writer.sqlite"),
      }),
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) fail(`前台包装脚本无法在安装包内启动：${result.error.message}`);
    if (result.status !== 0) {
      fail(`前台包装脚本在安装包内退出码 ${result.status}：${String(result.stderr || "").trim().slice(0, 200)}`);
    }
    if (!String(result.stdout || "").includes(marker)) {
      fail("前台包装脚本在安装包内没有拉起被包装的命令（引擎将无法启动）");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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

console.log(`[verify-mac-pack] ok — base Python runtime present, foreground launcher runs from the asar — ${path.relative(ROOT, appPath)}`);
