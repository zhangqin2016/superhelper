#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-catalog-"));

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
process.resourcesPath = ROOT;
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
      getVersion: () => "0.1.0",
    },
  },
};

const skillManager = require(path.join(ROOT, "src/main/skill-manager.js"));
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(
  path.join(tmp, "skills-state.json"),
  JSON.stringify({
    schemaVersion: 1,
    registryUrl: "https://stale-user-registry.example.com/registry.json",
    skills: {},
  }),
);
skillManager.bootstrapSkills();

const result = await skillManager.checkRegistryUpdates({ fetch: false });
if (!result.ok) {
  throw new Error(`bundled skill catalog failed: ${JSON.stringify(result)}`);
}
if (!result.bundledCatalog) {
  throw new Error("expected bundled catalog");
}
if ((result.available || []).length < 100) {
  throw new Error(`expected 100+ available skills, got ${result.available?.length || 0}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-catalog: ok", result.available.length, "available");
