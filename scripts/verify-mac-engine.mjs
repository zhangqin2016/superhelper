#!/usr/bin/env node
/**
 * Verify the bundled Claude engine matches the macOS package architecture.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function fail(message) {
  console.error(`[verify-mac-engine] ${message}`);
  process.exit(1);
}

const platform = argValue("--platform") || (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64");
if (!["darwin-arm64", "darwin-x64"].includes(platform)) {
  fail(`unsupported platform: ${platform}`);
}

const engine = path.join(ROOT, "bundles", platform, "engine-upstream");
if (!fs.existsSync(engine)) {
  fail(`missing ${path.relative(ROOT, engine)}. Intel Mac 包需要 darwin-x64 的 engine-upstream，不能复用 arm64。`);
}

const result = spawnSync("file", [engine], { encoding: "utf8" });
if (result.status !== 0) {
  fail(`could not inspect ${path.relative(ROOT, engine)}`);
}

const output = result.stdout || "";
if (platform === "darwin-arm64" && !/\barm64\b/.test(output)) {
  fail(`${path.relative(ROOT, engine)} is not arm64: ${output.trim()}`);
}
if (platform === "darwin-x64" && !/\bx86_64\b/.test(output)) {
  fail(`${path.relative(ROOT, engine)} is not x86_64: ${output.trim()}`);
}

console.log(`[verify-mac-engine] ok — ${platform}`);
