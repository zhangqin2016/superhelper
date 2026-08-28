#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const expected = "1.18.21";
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const fetchScript = fs.readFileSync("scripts/fetch-opencode-engine.mjs", "utf8");
const versionDoc = fs.readFileSync("docs/opencode-source-version.md", "utf8");

assert.equal(packageJson.dependencies?.["@opencode-ai/sdk"], expected, "SDK must match the bundled engine release");
assert.equal(packageLock.packages?.[""]?.dependencies?.["@opencode-ai/sdk"], expected, "lockfile root SDK declaration must match the bundled engine release");
assert.equal(packageLock.packages?.["node_modules/@opencode-ai/sdk"]?.version, expected, "lockfile SDK package must match the bundled engine release");
assert.match(fetchScript, new RegExp(`\\|\\| \"${expected}\"`), "engine fetch default must match the SDK release");
assert.match(versionDoc, new RegExp(`v${expected}`), "engine source version documentation must match the release");
assert.match(versionDoc, new RegExp(`opencode-ai@${expected}`), "engine package documentation must match the release");
assert.match(versionDoc, new RegExp(`@opencode-ai/sdk@${expected}`), "SDK documentation must match the release");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-sdk-alignment-"));
try {
  fs.mkdirSync(path.join(temp, "scripts"));
  fs.mkdirSync(path.join(temp, "node_modules/@opencode-ai/sdk"), { recursive: true });
  fs.copyFileSync("scripts/verify-engine-bundle.mjs", path.join(temp, "scripts/verify-engine-bundle.mjs"));
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify(packageJson));
  const check = () => spawnSync(process.execPath, [path.join(temp, "scripts/verify-engine-bundle.mjs")], { encoding: "utf8" });
  assert.match(check().stderr, /未安装 OpenCode SDK/, "missing installed SDK blocks packaging");
  fs.writeFileSync(path.join(temp, "node_modules/@opencode-ai/sdk/package.json"), JSON.stringify({ version: "1.18.18" }));
  assert.match(check().stderr, /installed=1.18.18/, "stale dependency cache blocks packaging even when manifest is current");
  fs.writeFileSync(path.join(temp, "node_modules/@opencode-ai/sdk/package.json"), JSON.stringify({ version: expected }));
  const aligned = check();
  assert.doesNotMatch(aligned.stderr, /SDK 与锁定版本不一致/);
  assert.match(aligned.stderr, /缺少 OpenCode 引擎二进制/, "matching SDK proceeds to the independent binary gate");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("opencode version alignment: ok");
