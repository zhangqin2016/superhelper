#!/usr/bin/env node
/**
 * spawn-env must expose the bundled web Node runtime to every agent process.
 * The Electron node shim makes `node` executable; these env vars make
 * Node-based Playwright scripts able to `require("playwright")`.
 */
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");

function platformBundleKey() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win32-x64";
  return "linux-x64";
}

const fakeResources = fs.mkdtempSync(path.join(os.tmpdir(), "lily-web-runtime-"));
process.resourcesPath = fakeResources;

const runtimeRoot = path.join(fakeResources, "bundles", platformBundleKey(), "runtime");
const nodeExecutable = path.join(runtimeRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const nodeModules = path.join(runtimeRoot, "web", "node_modules");
const browsers = path.join(runtimeRoot, "web", "browsers");
fs.mkdirSync(path.dirname(nodeExecutable), { recursive: true });
fs.mkdirSync(path.join(nodeModules, "playwright"), { recursive: true });
fs.mkdirSync(browsers, { recursive: true });
fs.writeFileSync(nodeExecutable, "");
fs.writeFileSync(path.join(nodeModules, "playwright", "package.json"), JSON.stringify({ name: "playwright" }));

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === "userData") return path.join(fakeResources, "user-data");
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
    },
  },
};

const { buildAgentSpawnEnv } = require(path.join(ROOT, "src/main/spawn-env.js"));
const env = buildAgentSpawnEnv();

if (env.NODE_PATH !== nodeModules) {
  throw new Error(`spawn env NODE_PATH should point at bundled web node_modules, got ${env.NODE_PATH}`);
}
if (env.LILY_PLAYWRIGHT_NODE_MODULES !== nodeModules) {
  throw new Error(`spawn env missing LILY_PLAYWRIGHT_NODE_MODULES, got ${env.LILY_PLAYWRIGHT_NODE_MODULES}`);
}
if (env.PLAYWRIGHT_BROWSERS_PATH !== browsers) {
  throw new Error(`spawn env browsers path mismatch, got ${env.PLAYWRIGHT_BROWSERS_PATH}`);
}
if (!env.PATH.split(path.delimiter).includes(path.dirname(nodeExecutable))) {
  throw new Error(`spawn env PATH missing bundled Node directory: ${env.PATH}`);
}

fs.rmSync(fakeResources, { recursive: true, force: true });
console.log("PASS: test-spawn-env-web-runtime");
