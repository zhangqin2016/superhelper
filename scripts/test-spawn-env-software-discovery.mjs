#!/usr/bin/env node
/**
 * Packaged Lily must be able to discover locally installed command-line tools.
 * Finder/Explorer launches do not reliably carry the user's interactive PATH,
 * so spawn-env must merge bounded platform and login-shell path entries without
 * exposing the rest of the host environment.
 */
import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");
const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-software-discovery-"));
const discoveredBin = path.join(mockUserData, "custom-bin");
fs.mkdirSync(discoveredBin, { recursive: true });

if (!process.resourcesPath) process.resourcesPath = ROOT;

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === "userData") return mockUserData;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
    },
  },
};

try {
  const { buildAgentSpawnEnv } = require(path.join(ROOT, "src/main/spawn-env.js"));
  const env = buildAgentSpawnEnv({
    lilyEnv: {},
    discoverHostPath: () => [
      discoveredBin,
      "relative/path",
      ".",
      "/usr/local/bin",
    ],
  });
  const entries = String(env.PATH || "").split(path.delimiter);

  if (process.platform === "darwin") {
    for (const expected of ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"]) {
      if (!entries.includes(expected)) throw new Error(`packaged macOS PATH missing ${expected}`);
    }
  } else if (process.platform === "win32") {
    const system32 = path.join(process.env.WINDIR || "C:\\Windows", "System32");
    if (!entries.includes(system32)) throw new Error(`packaged Windows PATH missing ${system32}`);
  } else {
    for (const expected of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
      if (!entries.includes(expected)) throw new Error(`packaged Linux PATH missing ${expected}`);
    }
  }

  if (!entries.includes(discoveredBin)) {
    throw new Error("packaged PATH dropped a discovered user executable directory");
  }
  if (entries.includes(".") || entries.includes("relative/path")) {
    throw new Error("packaged PATH admitted an unsafe relative directory");
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error("packaged PATH contains duplicate entries");
  }
  console.log("PASS: test-spawn-env-software-discovery");
} finally {
  fs.rmSync(mockUserData, { recursive: true, force: true });
}
