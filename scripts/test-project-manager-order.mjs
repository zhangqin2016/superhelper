#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-project-order-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");

const { projectsConfigPath } = require("../src/main/config.js");
const ProjectManager = require("../src/main/project-manager.js");

function workspace(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(projectsConfigPath()), { recursive: true });
  fs.writeFileSync(projectsConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

function readConfig() {
  return JSON.parse(fs.readFileSync(projectsConfigPath(), "utf8"));
}

function projectIds(manager) {
  return manager.getAppState().projects.map((project) => project.id);
}

try {
  const paths = {
    a: workspace("A"),
    b: workspace("B"),
    c: workspace("C"),
    d: workspace("D"),
  };
  const legacyConfig = {
    activeProjectId: "b",
    projects: [
      { id: "a", name: "A", path: paths.a, pinned: false },
      { id: "b", name: "B", path: paths.b, pinned: true },
      { id: "c", name: "C", path: paths.c, pinned: false },
      { id: "d", name: "D", path: paths.d, pinned: true },
    ],
  };

  writeConfig(legacyConfig);
  const manager = new ProjectManager(workspace("Default"));
  manager.load();

  assert.deepEqual(
    projectIds(manager),
    ["b", "d", "a", "c"],
    "legacy pinned and unpinned projects should be stably merged once",
  );
  assert.equal(readConfig().workspaceOrderVersion, 1);
  assert.ok(
    readConfig().projects.every((project) => !Object.hasOwn(project, "pinned")),
    "migration should remove every persisted pinned field",
  );
  assert.ok(
    manager.projects.every((project) => !Object.hasOwn(project, "pinned")),
    "normalized projects should not retain pinned",
  );
  assert.ok(
    manager
      .getAppState()
      .projects.every((project) => !Object.hasOwn(project, "pinned")),
    "migrated project summaries should not expose pinned",
  );

  const afterFirstLoad = fs.readFileSync(projectsConfigPath(), "utf8");
  const reload = new ProjectManager(workspace("Default"));
  const realReloadSave = reload.save;
  let secondLoadSaveCalls = 0;
  reload.save = function (...args) {
    secondLoadSaveCalls += 1;
    return realReloadSave.apply(this, args);
  };
  reload.load();
  reload.save = realReloadSave;
  assert.equal(
    secondLoadSaveCalls,
    0,
    "loading a versioned project order should not call save",
  );
  assert.equal(
    fs.readFileSync(projectsConfigPath(), "utf8"),
    afterFirstLoad,
    "the version marker should prevent migration from running again",
  );
  assert.deepEqual(
    projectIds(reload),
    ["b", "d", "a", "c"],
    "getAppState should preserve the persisted array order",
  );

  assert.deepEqual(reload.reorder(["c", "b", "d", "a"]), { ok: true });
  assert.deepEqual(projectIds(reload), ["c", "b", "d", "a"]);
  assert.deepEqual(
    readConfig().projects.map((project) => project.id),
    ["c", "b", "d", "a"],
    "a complete valid order should be persisted",
  );

  const stableConfig = fs.readFileSync(projectsConfigPath(), "utf8");
  const realSaveForInvalidOrder = reload.save;
  let invalidOrderSaveCalls = 0;
  reload.save = () => {
    invalidOrderSaveCalls += 1;
    throw new Error("UNEXPECTED_INVALID_ORDER_SAVE");
  };
  for (const invalidOrder of [
    ["c", "b", "d"],
    ["c", "b", "d", "d"],
    ["c", "b", "d", "missing"],
    ["c", "b", "d", "a", "extra"],
    "c,b,d,a",
    null,
  ]) {
    assert.throws(
      () => reload.reorder(invalidOrder),
      /INVALID_PROJECT_ORDER/,
      `invalid order should be rejected: ${JSON.stringify(invalidOrder)}`,
    );
    assert.deepEqual(projectIds(reload), ["c", "b", "d", "a"]);
    assert.equal(
      fs.readFileSync(projectsConfigPath(), "utf8"),
      stableConfig,
      "invalid order must not write the configuration",
    );
  }
  assert.equal(
    invalidOrderSaveCalls,
    0,
    "invalid orders must be rejected before save is called",
  );
  reload.save = realSaveForInvalidOrder;

  const beforeFailure = reload.projects;
  const realSave = reload.save;
  reload.save = () => {
    throw new Error("disk full");
  };
  assert.throws(() => reload.reorder(["a", "b", "c", "d"]), /disk full/);
  assert.equal(
    reload.projects,
    beforeFailure,
    "a failed reorder save should restore the previous in-memory array",
  );
  assert.deepEqual(projectIds(reload), ["c", "b", "d", "a"]);
  reload.save = realSave;

  const newPath = workspace("Newest");
  const added = reload.add(newPath);
  assert.equal(
    Object.hasOwn(added, "pinned"),
    false,
    "new projects should not generate pinned",
  );
  assert.equal(projectIds(reload)[0], added.id, "new projects should be inserted first");
  const addedSummary = reload
    .getAppState()
    .projects.find((project) => project.id === added.id);
  assert.equal(
    Object.hasOwn(addedSummary, "pinned"),
    false,
    "new project summaries should not expose pinned",
  );
  reload.add(paths.b);
  assert.equal(
    projectIds(reload)[0],
    added.id,
    "reopening an existing project should not move it",
  );

  const invalidConfigs = [
    {
      name: "malformed JSON",
      content: '{"activeProjectId":',
      validateError: (error) => error instanceof SyntaxError,
    },
    {
      name: "non-object root",
      content: "[]",
      validateError: (error) => error?.code === "INVALID_PROJECTS_CONFIG",
    },
    {
      name: "non-array projects",
      content: JSON.stringify({ activeProjectId: null, projects: {} }),
      validateError: (error) => error?.code === "INVALID_PROJECTS_CONFIG",
    },
  ];
  for (const invalidConfig of invalidConfigs) {
    fs.writeFileSync(projectsConfigPath(), invalidConfig.content, "utf8");
    const originalBytes = fs.readFileSync(projectsConfigPath());
    const invalidManager = new ProjectManager(workspace(`Invalid ${invalidConfig.name}`));
    let invalidSaveCalls = 0;
    invalidManager.save = () => {
      invalidSaveCalls += 1;
    };

    assert.throws(
      () => invalidManager.load(),
      invalidConfig.validateError,
      `${invalidConfig.name} should fail load explicitly`,
    );
    assert.equal(
      invalidSaveCalls,
      0,
      `${invalidConfig.name} must not trigger save`,
    );
    assert.deepEqual(
      fs.readFileSync(projectsConfigPath()),
      originalBytes,
      `${invalidConfig.name} must leave the original config bytes untouched`,
    );
  }

  writeConfig({ activeProjectId: null });
  const missingProjectsManager = new ProjectManager(workspace("Missing Projects"));
  assert.doesNotThrow(
    () => missingProjectsManager.load(),
    "legacy configs without a projects field should remain valid",
  );
  assert.deepEqual(
    missingProjectsManager.getAppState().projects,
    [],
    "a missing projects field should retain the historical empty-list behavior",
  );
  assert.equal(
    readConfig().workspaceOrderVersion,
    1,
    "a valid legacy config without projects should still receive the order version",
  );

  writeConfig({
    activeProjectId: null,
    projects: [],
    workspaceOrderVersion: 1,
  });
  const permissionDeniedBytes = fs.readFileSync(projectsConfigPath());
  const permissionDeniedManager = new ProjectManager(workspace("Permission Denied"));
  let permissionDeniedSaveCalls = 0;
  permissionDeniedManager.save = () => {
    permissionDeniedSaveCalls += 1;
  };
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(projectsConfigPath())) {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    }
    return realReadFileSync(file, ...args);
  };
  try {
    assert.throws(
      () => permissionDeniedManager.load(),
      (error) => error?.code === "EACCES",
      "read permission errors should propagate",
    );
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  assert.equal(
    permissionDeniedSaveCalls,
    0,
    "read permission errors must not trigger save",
  );
  assert.deepEqual(
    fs.readFileSync(projectsConfigPath()),
    permissionDeniedBytes,
    "read permission errors must leave the original config bytes untouched",
  );

  writeConfig(legacyConfig);
  const originalLegacyConfig = fs.readFileSync(projectsConfigPath(), "utf8");
  const failedMigration = new ProjectManager(workspace("Migration Failure Default"));
  const realRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === projectsConfigPath()) {
      throw new Error("rename denied");
    }
    return realRenameSync(source, destination);
  };
  try {
    assert.throws(() => failedMigration.load(), /rename denied/);
  } finally {
    fs.renameSync = realRenameSync;
  }
  assert.equal(
    fs.readFileSync(projectsConfigPath(), "utf8"),
    originalLegacyConfig,
    "a failed migration save must leave the legacy file untouched",
  );
  assert.deepEqual(
    projectIds(failedMigration),
    ["a", "b", "c", "d"],
    "a failed migration save should restore the pre-migration in-memory order",
  );
  assert.ok(
    failedMigration.projects.every((project) => Object.hasOwn(project, "pinned")),
    "a failed migration save should restore the complete legacy in-memory records",
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(projectsConfigPath())).sort(),
    [path.basename(projectsConfigPath())],
    "a failed migration save should not leave a partial temporary config",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("project-manager-order: ok");
