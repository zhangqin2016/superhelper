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
    manifest: {
      name: "Stock Dashboard",
      version: "1.0.0",
      appRuntime: {
        manifestPath: "lily-app.json",
        defaultEntrypoint: "analyze_stock",
        resultPath: "source/reports/lily-result.json",
      },
    },
    project,
    targetDir: appDir,
    installParentDir: path.dirname(appDir),
    installedDependencies: { skills: ["lily-research"], runtimePacks: ["pro-pdf"] },
  });
  assert.equal(record.id, "stock-dashboard");
  assert.ok(record.instanceId);
  assert.equal(record.version, "1.0.0");
  assert.equal(record.appRuntime.defaultEntrypoint, "analyze_stock");
  assert.equal(record.appRuntime.resultPath, "source/reports/lily-result.json");
  assert.equal(installs.listInstalled().length, 1);
  assert.equal(installs.isInsideInstallRoot(defaultWorkspace, appDir), true);
  assert.equal(installs.isInsideInstallRoot(defaultWorkspace, path.join(tmp, "Other", "x")), false);
  assert.equal(installs.canRemoveInstalledWorkspace(defaultWorkspace, record), true);
  assert.equal(installs.preferredInstallDialogPath(defaultWorkspace, record), appDir);
  assert.deepEqual(
    installs.resolveInstallTarget({
      selectedDir: appDir,
      defaultWorkspacePath: defaultWorkspace,
      record,
      baseName: "Stock Dashboard",
    }),
    {
      baseDir: path.dirname(appDir),
      targetDir: appDir,
      replaceExisting: true,
    },
  );
  assert.deepEqual(
    installs.resolveInstallTarget({
      selectedDir: path.join(tmp, "Other Apps"),
      defaultWorkspacePath: defaultWorkspace,
      record,
      baseName: "Stock Dashboard",
    }),
    {
      baseDir: path.join(tmp, "Other Apps"),
      targetDir: path.join(tmp, "Other Apps", "Stock Dashboard"),
      replaceExisting: false,
    },
  );

  const customParent = path.join(tmp, "Custom Apps");
  const customDir = path.join(customParent, "Custom Stock");
  const customRecord = {
    ...record,
    path: customDir,
    installParentDir: customParent,
    managedByAppStore: true,
  };
  assert.equal(installs.canRemoveInstalledWorkspace(defaultWorkspace, customRecord), true);
  assert.equal(installs.canRemoveInstalledWorkspace(defaultWorkspace, {
    ...customRecord,
    path: customParent,
  }), false);
  assert.equal(installs.canRemoveInstalledWorkspace(defaultWorkspace, {
    ...customRecord,
    path: path.join(customParent, "nested", "Custom Stock"),
  }), false);

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
  assert.equal(result.json.apps[0].installedCount, 1);
  assert.equal(result.json.apps[0].installedInstances[0].appRuntime.defaultEntrypoint, "analyze_stock");

  const secondDir = path.join(tmp, "Custom Apps", "Stock Dashboard 2");
  fs.mkdirSync(secondDir, { recursive: true });
  const secondRecord = installs.recordInstalled({
    app: {
      id: "stock-dashboard",
      name: "Stock Dashboard",
      latestVersion: "1.1.0",
      sha256: "b".repeat(64),
      downloadUrl: "https://cdn.example.com/stock-1.1.zip",
    },
    manifest: { name: "Stock Dashboard", version: "1.1.0" },
    project: { id: "project-2", name: "Stock Dashboard" },
    targetDir: secondDir,
    installParentDir: path.dirname(secondDir),
    installedDependencies: { skills: [], runtimePacks: [] },
  });
  assert.equal(secondRecord.supersededProjectId, null);
  assert.equal(installs.listInstalled().length, 2);
  assert.equal(installs.readState().history.length, 0);

  const updatedRecord = installs.recordInstalled({
    app: {
      id: "stock-dashboard",
      name: "Stock Dashboard",
      latestVersion: "1.1.1",
      sha256: "c".repeat(64),
      downloadUrl: "https://cdn.example.com/stock-1.1.1.zip",
    },
    manifest: { name: "Stock Dashboard", version: "1.1.1" },
    project: { id: "project-3", name: "Stock Dashboard" },
    targetDir: secondDir,
    installParentDir: path.dirname(secondDir),
    installedDependencies: { skills: [], runtimePacks: [] },
    replaceInstanceId: secondRecord.instanceId,
  });
  assert.equal(updatedRecord.instanceId, secondRecord.instanceId);
  assert.equal(updatedRecord.supersededProjectId, "project-2");
  assert.equal(updatedRecord.supersededPath, secondDir);
  assert.equal(installs.listInstalled().length, 2);
  assert.equal(installs.readState().history.length, 1);

  const multiResult = installs.attachInstalledState({
    ok: true,
    json: {
      apps: [{
        id: "stock-dashboard",
        latestVersion: "1.1.1",
        name: "Stock Dashboard",
      }],
    },
  }, {
    find: (id) => (["project-1", "project-3"].includes(id) ? { id } : null),
  });
  assert.equal(multiResult.json.apps[0].installedCount, 2);
  assert.equal(multiResult.json.apps[0].installedInstances.length, 2);

  const cachedCatalog = installs.withCatalogCacheFallback({
    ok: true,
    json: {
      schemaVersion: 1,
      publisher: "Test Apps",
      updatedAt: "2026-06-26T00:00:00.000Z",
      apps: [{
        id: "stock-dashboard",
        latestVersion: "1.1.1",
        name: "Stock Dashboard",
      }],
    },
  });
  assert.equal(cachedCatalog.ok, true);

  const removed = installs.forgetInstalled("stock-dashboard");
  assert.equal(removed.id, "stock-dashboard");
  assert.equal(installs.listInstalled().length, 0);

  const fallbackCatalog = installs.withCatalogCacheFallback({
    ok: false,
    error: "SERVICE_REQUEST_FAILED",
  });
  assert.equal(fallbackCatalog.ok, true, "app catalog should fall back to the last successful catalog");
  assert.equal(fallbackCatalog.stale, true, "fallback catalog should be marked stale");
  const fallbackResult = installs.attachInstalledState(fallbackCatalog, {
    find: () => null,
  });
  assert.equal(fallbackResult.json.apps[0].id, "stock-dashboard");
  assert.equal(fallbackResult.json.apps[0].installed, false, "cached catalog must use current local uninstall state");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("workspace-app-installs: ok");
