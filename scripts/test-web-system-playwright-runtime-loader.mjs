#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const loader = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/playwright_runtime.cjs");

function runNode(code, env = {}) {
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`node failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-pw-loader-"));
const fakeNodeModules = path.join(fakeRoot, "web", "node_modules");
const fakePlaywright = path.join(fakeNodeModules, "playwright");
fs.mkdirSync(fakePlaywright, { recursive: true });
fs.writeFileSync(path.join(fakePlaywright, "package.json"), JSON.stringify({ name: "playwright", main: "index.js" }));
fs.writeFileSync(
  path.join(fakePlaywright, "index.js"),
  "module.exports = { chromium: { name: 'fake-chromium' } };\n",
);

const envResult = JSON.parse(runNode(`
  const rt = require(${JSON.stringify(loader)});
  const pw = rt.requirePlaywright();
  console.log(JSON.stringify({ source: pw.__lilyPlaywrightSource, chromium: pw.chromium.name }));
`, { LILY_PLAYWRIGHT_NODE_MODULES: fakeNodeModules }));

if (envResult.source !== fakeNodeModules || envResult.chromium !== "fake-chromium") {
  throw new Error(`loader did not honor LILY_PLAYWRIGHT_NODE_MODULES: ${JSON.stringify(envResult)}`);
}

const devResult = JSON.parse(runNode(`
  const rt = require(${JSON.stringify(loader)});
  const pw = rt.requirePlaywright();
  console.log(JSON.stringify({ source: pw.__lilyPlaywrightSource, hasChromium: Boolean(pw.chromium) }));
`, { LILY_PLAYWRIGHT_NODE_MODULES: "", PLAYWRIGHT_NODE_MODULES: "", NODE_PATH: "" }));

if (!devResult.hasChromium) {
  throw new Error(`loader did not return a chromium browser type: ${JSON.stringify(devResult)}`);
}

fs.rmSync(fakeRoot, { recursive: true, force: true });
console.log("PASS: test-web-system-playwright-runtime-loader");
