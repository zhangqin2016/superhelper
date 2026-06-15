#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-app-installs-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");

const installs = require("../src/main/workspace-app-installs.js");

try {
  const defaultWorkspace = path.join(tmp, "Lily Workbench");
  const appDir = path.join(tmp, "Lily Apps", "Stock Dashboard");
  fs.mkdirSync(appDir, { recursive: true });
  const project = { id: "project-1", name: "Stock Dashboard" };
  const record = installs.recordInstalled({
    app: {
      id: "stock-dashboard",
      name: "Stock Dashboard",
      latestVersion: "1.0.0",
      sha256: "a".repeat(64),
      downloadUrl: "https://cdn.example.com/stock.zip",
    },
    manifest: { name: "Stock Dashboard", version: "1.0.0" },
    project,
    targetDir: appDir,
    installedDependencies: { skills: ["lily-research"], runtimePacks: ["pro-pdf"] },
  });
  assert.equal(record.id, "stock-dashboard");
  assert.equal(record.version, "1.0.0");
  assert.equal(installs.listInstalled().length, 1);
  assert.equal(installs.isInsideInstallRoot(defaultWorkspace, appDir), true);
  assert.equal(installs.isInsideInstallRoot(defaultWorkspace, path.join(tmp, "Other", "x")), false);

  const result = installs.attachInstalledState({
    ok: true,
    json: {
      apps: [{
        id: "stock-dashboard",
        latestVersion: "1.1.0",
        name: "Stock Dashboard",
      }],
    },
  }, {
    find: (id) => (id === "project-1" ? project : null),
  });
  assert.equal(result.json.apps[0].installed, true);
  assert.equal(result.json.apps[0].installedVersion, "1.0.0");
  assert.equal(result.json.apps[0].updateAvailable, true);
  assert.equal(result.json.apps[0].installedAvailable, true);

  const removed = installs.forgetInstalled("stock-dashboard");
  assert.equal(removed.id, "stock-dashboard");
  assert.equal(installs.listInstalled().length, 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("workspace-app-installs: ok");
