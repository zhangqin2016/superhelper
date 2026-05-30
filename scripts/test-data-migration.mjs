#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: () => os.tmpdir(),
    },
  },
};

const { shouldPreferLegacyJson } = require(path.join(
  __dirname,
  "../src/main/data-migration.js",
));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "data-migration-test-"));
const legacyProjects = path.join(tmp, "legacy-projects.json");
const currentProjects = path.join(tmp, "current-projects.json");

fs.writeFileSync(
  legacyProjects,
  JSON.stringify({
    activeProjectId: "old-id",
    projects: [{ id: "old-id", name: "Old", path: "/tmp/old", pinned: false }],
  }),
);
fs.writeFileSync(
  currentProjects,
  JSON.stringify({ activeProjectId: null, projects: [] }),
);

if (
  shouldPreferLegacyJson("projects.json", currentProjects, legacyProjects)
) {
  throw new Error("expected empty current projects.json to block legacy restore");
}

fs.writeFileSync(currentProjects, "{not json");
if (
  !shouldPreferLegacyJson("projects.json", currentProjects, legacyProjects)
) {
  throw new Error("expected corrupt current projects.json to allow legacy restore");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("data-migration: ok");
