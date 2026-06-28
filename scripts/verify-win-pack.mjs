#!/usr/bin/env node
/**
 * After `electron-builder --win --dir`, ensure Mac bundles were not shipped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = path.join(ROOT, "dist", "win-unpacked");
const bundlesRoot = path.join(unpacked, "resources", "bundles");
const expectRuntime = process.argv.includes("--expect-runtime");

function fail(msg) {
  console.error(`[verify-win-pack] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(unpacked)) {
  fail("dist/win-unpacked 不存在，请先运行 dist:win 或 electron-builder --win --dir");
}

const forbidden = ["darwin-arm64", "darwin-x64", "linux-x64"];
for (const name of forbidden) {
  if (fs.existsSync(path.join(bundlesRoot, name))) {
    fail(`不应包含 ${name}，Windows 包应仅有 win32-x64`);
  }
}

const winBundle = path.join(bundlesRoot, "win32-x64");
if (!fs.existsSync(winBundle)) {
  fail("缺少 resources/bundles/win32-x64");
}

// The actual engine binary must be in the package, not just the directory —
// otherwise every send fails with OPENCODE_NOT_READY on users' machines.
const winEngine = path.join(winBundle, "opencode", "bin", "opencode.exe");
if (!fs.existsSync(winEngine)) {
  fail("缺少 OpenCode 引擎二进制 resources/bundles/win32-x64/opencode/bin/opencode.exe");
}
const winEngineSize = fs.statSync(winEngine).size;
if (winEngineSize < 5 * 1024 * 1024) {
  fail(`OpenCode 引擎二进制过小（${winEngineSize} 字节，疑似下载不完整）`);
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
if (!fs.existsSync(sharpNode)) {
  fail("缺少 sharp win32-x64 原生包，图片压缩主路径在 Windows 上不可用");
}

const imgRoot = path.join(unpacked, "resources", "app.asar.unpacked", "node_modules", "@img");
if (fs.existsSync(imgRoot)) {
  for (const entry of fs.readdirSync(imgRoot)) {
    if (/^sharp-(darwin|linux)-/.test(entry) || /^sharp-libvips-(darwin|linux)-/.test(entry)) {
      fail(`Windows 包不应包含 ${entry}`);
    }
  }
}

if (expectRuntime) {
  const manifest = path.join(winBundle, "runtime", "runtime-manifest.json");
  if (!fs.existsSync(manifest)) {
    fail("完整安装包应包含 win32-x64/runtime，但未找到 runtime-manifest.json");
  }
  console.log("[verify-win-pack] runtime manifest ok");
}

let fileCount = 0;
let totalBytes = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      fileCount += 1;
      totalBytes += fs.statSync(full).size;
    }
  }
}
walk(unpacked);

const mb = (totalBytes / (1024 * 1024)).toFixed(0);

const { execFileSync } = await import("node:child_process");
try {
  execFileSync(
    process.execPath,
    ["scripts/purge-macos-junk.mjs", "--verify", unpacked],
    { cwd: ROOT, stdio: "inherit" },
  );
} catch {
  fail("安装包内含有 __MACOSX / .DS_Store 等 macOS 元数据，Windows 技能安装可能失败");
}

console.log(
  `[verify-win-pack] ok — ${fileCount} files, ~${mb} MB unpacked, win32-x64 present`,
);
