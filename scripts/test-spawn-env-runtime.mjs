#!/usr/bin/env node
/**
 * spawn-env + runtime PATH integration (mock Electron, no GUI).
 */
import module from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");

if (!process.resourcesPath) {
  process.resourcesPath = ROOT;
}

const mockUserData = path.join(os.tmpdir(), "lily-workbench-test-userdata");
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return mockUserData;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
    },
  },
};

const { buildAgentSpawnEnv } = require(path.join(__dirname, "../src/main/spawn-env.js"));
const runtimePython = require(path.join(__dirname, "../src/main/runtime-python.js"));

const env = buildAgentSpawnEnv();
const delim = path.delimiter;
const pathParts = env.PATH.split(delim);
const expected = runtimePython.getRuntimePathEntries();

if (!runtimePython.getRuntimeSummary().available) {
  console.log("spawn-env-runtime: ok (no bundle — skipped PATH assertion)");
  process.exit(0);
}

for (const entry of expected) {
  if (!pathParts.includes(entry)) {
    throw new Error(`spawn-env PATH missing runtime entry: ${entry}`);
  }
}

if (!env.LILY_RUNTIME_ROOT) {
  throw new Error("spawn-env missing LILY_RUNTIME_ROOT");
}

console.log("spawn-env-runtime: ok", expected.length, "entries in PATH");
