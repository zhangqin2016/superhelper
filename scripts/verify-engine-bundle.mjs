#!/usr/bin/env node
/**
 * Pre-pack guard: verify the OpenCode engine binary for a given platform is
 * actually present, non-trivial, and (on non-Windows) executable BEFORE it gets
 * packaged. Run right after fetch-opencode-engine.mjs in the dist scripts.
 *
 * Why: bundles/<key>/opencode/ is gitignored and produced at package time. If the
 * fetch silently failed or produced a truncated/non-executable binary, the app
 * ships without a runnable engine and every send fails with OPENCODE_NOT_READY on
 * users' machines — while the developer (who has a local engine) never reproduces
 * it. Fail the build loud here instead.
 *
 *   node scripts/verify-engine-bundle.mjs --platform darwin-arm64
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function platformKey() {
  const i = process.argv.indexOf("--platform");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win32-x64";
  return "linux-x64";
}

function fail(msg) {
  console.error(`[verify-engine-bundle] ${msg}`);
  process.exit(1);
}

const key = platformKey();
const exe = key.startsWith("win32") ? "opencode.exe" : "opencode";
const binary = path.join(ROOT, "bundles", key, "opencode", "bin", exe);
const rel = path.relative(ROOT, binary);

// A real engine binary is tens of MB; this catches an empty/placeholder/truncated
// download long before electron-builder happily packages a dud.
const MIN_BYTES = 5 * 1024 * 1024;

let stat;
try {
  stat = fs.statSync(binary);
} catch {
  fail(`缺少 OpenCode 引擎二进制: ${rel}（fetch-opencode-engine.mjs --platform ${key} 未成功？）`);
}
if (!stat.isFile()) fail(`OpenCode 引擎路径不是文件: ${rel}`);
if (stat.size < MIN_BYTES) {
  fail(`OpenCode 引擎二进制过小（${stat.size} 字节，疑似下载不完整）: ${rel}`);
}
if (!key.startsWith("win32") && !(stat.mode & 0o111)) {
  fail(`OpenCode 引擎缺少可执行权限（chmod +x）: ${rel}`);
}

console.log(`[verify-engine-bundle] ok: ${rel} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
