#!/usr/bin/env node
/**
 * Why this matters: OpenCode spawns node-based language servers (pyright,
 * typescript-language-server) whose bins are `#!/usr/bin/env node` scripts. If
 * `node` is not on the agent PATH they fail to start and the code-intelligence
 * loop silently produces no diagnostics. The runtime bundle ships no standalone
 * node, but Playwright vendors a full one under its driver dir — these tests
 * pin that we discover it and surface it on the runtime PATH.
 */
import module from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");

if (!process.resourcesPath) process.resourcesPath = ROOT;

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: (name) => (name === "userData" ? os.tmpdir() : os.tmpdir()),
    },
  },
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Build a fake runtime bundle that mirrors the real layout: a manifest (so the
// resolver accepts the root) + Playwright's vendored node under the driver dir.
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-rt-node-"));
fs.writeFileSync(
  path.join(fakeRoot, "runtime-manifest.json"),
  JSON.stringify({ platform: `${process.platform}-${process.arch}` }),
);
const isWin = process.platform === "win32";
const driverDir = isWin
  ? path.join(fakeRoot, "venv", "Lib", "site-packages", "playwright", "driver")
  : path.join(fakeRoot, "venv", "lib", "python3.12", "site-packages", "playwright", "driver");
fs.mkdirSync(driverDir, { recursive: true });
const nodeExe = path.join(driverDir, isWin ? "node.exe" : "node");
fs.writeFileSync(nodeExe, "#!/bin/sh\n", { mode: 0o755 });

process.env.LILY_RUNTIME_ROOT = fakeRoot;

const runtimePython = require(path.join(ROOT, "src/main/runtime-python.js"));

// 1. The resolver finds the dir that holds node.
const resolved = runtimePython.resolveBundledNodeDir(fakeRoot);
assert(resolved === driverDir, `resolveBundledNodeDir: expected ${driverDir}, got ${resolved}`);

// 2. That dir is surfaced on the runtime PATH entries (so the engine inherits it).
const entries = runtimePython.getRuntimePathEntries();
assert(entries.includes(driverDir), "getRuntimePathEntries must include the node dir");

// 3. No false positive when node is absent.
fs.rmSync(nodeExe);
assert(
  runtimePython.resolveBundledNodeDir(fakeRoot) === null,
  "resolveBundledNodeDir must return null when no node binary is present",
);

fs.rmSync(fakeRoot, { recursive: true, force: true });
console.log("runtime-node-path: ok");
