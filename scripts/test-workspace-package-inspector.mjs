#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-package-inspector-"));

try {
  const {
    exportWorkspacePack,
    readPackManifest,
    SCHEMA_VERSION,
  } = await import("../src/main/workspace-share.js").then((mod) => mod.default || mod);
  const { inspectWorkspacePackage } = await import("../src/main/workspace-package-inspector.js").then((mod) => mod.default || mod);
  const {
    computePackContentSha256,
    importWorkspacePackagePath,
    verifyLocalApp,
  } = await import("../src/main/workspace-import-service.js").then((mod) => mod.default || mod);
  const { signDetached } = await import("../src/main/crypto-signing.js").then((mod) => mod.default || mod);

  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Inspect me\n");
  const portableTask = {
    title: "Daily summary",
    prompt: "Summarize changes",
    schedule: { type: "daily", hour: 18, minute: 0 },
    scheduleText: "Daily at 18:00",
    permissionMode: "read_only",
  };
  const workspacePack = await exportWorkspacePack({
    rootPath: workspace,
    name: "Inspected workspace",
    requiredSkills: ["lily-documents"],
    automationTemplates: [portableTask],
    exportedAt: "2026-07-26T00:00:00.000Z",
  });
  const disguisedPath = path.join(tmp, "workspace-package.bin");
  fs.writeFileSync(disguisedPath, workspacePack);

  const inspectedWorkspace = await inspectWorkspacePackage(disguisedPath);
  assert.equal(inspectedWorkspace.ok, true);
  assert.equal(inspectedWorkspace.recognized, true, "manifest content identifies the package, not its extension");
  assert.equal(inspectedWorkspace.kind, "lily-workspace-pack");
  assert.equal(inspectedWorkspace.name, "Inspected workspace");
  assert.deepEqual(inspectedWorkspace.requiredSkills, ["lily-documents"]);
  assert.equal(inspectedWorkspace.automationTemplates.length, 1);
  assert.equal(inspectedWorkspace.automationCount, 1);

  const appWorkspace = path.join(tmp, "app");
  fs.mkdirSync(appWorkspace, { recursive: true });
  fs.writeFileSync(path.join(appWorkspace, "index.html"), "<h1>App</h1>");
  fs.writeFileSync(path.join(appWorkspace, "lily-app.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "local-demo",
    type: "workspace_app",
    name: "Local demo",
    version: "1.2.3",
    requiredSkills: ["lily-browser-qa"],
    requiredRuntimePacks: ["rembg"],
  }));
  const appPath = path.join(tmp, "local-demo.zip");
  fs.writeFileSync(appPath, await exportWorkspacePack({
    rootPath: appWorkspace,
    name: "Local demo",
    exportedAt: "2026-07-26T00:00:00.000Z",
  }));
  const inspectedApp = await inspectWorkspacePackage(appPath);
  assert.equal(inspectedApp.recognized, true);
  assert.equal(inspectedApp.kind, "lily-workspace-app");
  assert.equal(inspectedApp.appId, "local-demo");
  assert.equal(inspectedApp.version, "1.2.3");
  assert.deepEqual(inspectedApp.requiredSkills, ["lily-browser-qa"]);
  assert.deepEqual(inspectedApp.requiredRuntimePacks, ["rembg"]);

  const signedZip = await JSZip.loadAsync(fs.readFileSync(appPath));
  const signedManifest = JSON.parse(
    await signedZip.file(".lilyspace/lily-workspace.json").async("string"),
  );
  const contentSha256 = await computePackContentSha256(signedZip);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  signedManifest.signature = signDetached(
    { appId: signedManifest.appId, sha256: contentSha256 },
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  signedZip.file(".lilyspace/lily-workspace.json", JSON.stringify(signedManifest));
  const signedRead = await readPackManifest(
    await signedZip.generateAsync({ type: "nodebuffer" }),
  );
  await verifyLocalApp(signedRead.manifest, signedRead.zip, { publicKey: publicKeyPem });
  signedRead.zip.file("index.html", "<h1>Tampered</h1>");
  await assert.rejects(
    () => verifyLocalApp(signedRead.manifest, signedRead.zip, { publicKey: publicKeyPem }),
    /SIGNATURE_INVALID/,
  );

  const plainZip = new JSZip();
  plainZip.file("notes.txt", "ordinary attachment");
  const plainPath = path.join(tmp, "ordinary.zip");
  fs.writeFileSync(plainPath, await plainZip.generateAsync({ type: "nodebuffer" }));
  const inspectedPlain = await inspectWorkspacePackage(plainPath);
  assert.equal(inspectedPlain.ok, true);
  assert.equal(inspectedPlain.recognized, false, "ordinary ZIP remains an attachment");

  const corruptPath = path.join(tmp, "corrupt.zip");
  fs.writeFileSync(corruptPath, "not a zip");
  const inspectedCorrupt = await inspectWorkspacePackage(corruptPath);
  assert.equal(inspectedCorrupt.ok, true);
  assert.equal(inspectedCorrupt.recognized, false, "corrupt ZIP remains on the attachment fallback");

  const futureZip = new JSZip();
  futureZip.file("lily-workspace.json", JSON.stringify({
    kind: "lily-workspace-pack",
    schemaVersion: SCHEMA_VERSION + 1,
    name: "Future",
  }));
  futureZip.file("files/README.md", "future");
  const futurePath = path.join(tmp, "future.zip");
  fs.writeFileSync(futurePath, await futureZip.generateAsync({ type: "nodebuffer" }));
  const inspectedFuture = await inspectWorkspacePackage(futurePath);
  assert.equal(inspectedFuture.recognized, false, "future package is not intercepted during chat drop");

  const limited = await inspectWorkspacePackage(disguisedPath, {
    maxPackageBytes: workspacePack.length - 1,
  });
  assert.equal(limited.recognized, false, "oversized local package falls back without loading");
  assert.equal(limited.reason, "PACKAGE_TOO_LARGE");

  const missing = await inspectWorkspacePackage(path.join(tmp, "missing.zip"));
  assert.equal(missing.recognized, false);
  assert.equal(missing.reason, "NOT_A_FILE");
  const missingImport = await importWorkspacePackagePath({}, {
    filePath: path.join(tmp, "missing.zip"),
  });
  assert.deepEqual(missingImport, { ok: false, error: "NOT_A_FILE" });
  const oversizedImport = await importWorkspacePackagePath({
    maxWorkspacePackageBytes: workspacePack.length - 1,
  }, {
    filePath: disguisedPath,
  });
  assert.deepEqual(oversizedImport, { ok: false, error: "PACKAGE_TOO_LARGE" });

  const importedTasks = [];
  const projects = [];
  const importResult = await importWorkspacePackagePath({
    projectManager: {
      defaultPath: path.join(tmp, "default-workspace"),
      add: (targetPath) => {
        const project = { id: `project-${projects.length + 1}`, name: path.basename(targetPath), path: targetPath };
        projects.push(project);
        return project;
      },
      rename: (id, name) => {
        const project = projects.find((item) => item.id === id);
        if (project) project.name = name;
        return Boolean(project);
      },
      getAppState: () => ({ projects }),
    },
    sessionManager: {
      create: (projectId) => ({ id: `session-${projectId}`, projectId }),
    },
    scheduledTaskManager: {
      importPausedTemplates: (templates, scope) => {
        importedTasks.push({ templates, scope });
        return { ok: true, tasks: templates.map((task, index) => ({ ...task, id: `new-${index}`, enabled: false })) };
      },
    },
    skillManager: {
      restoreWorkspaceSkillDir: () => null,
      getGloballyEnabledSkillIds: () => [],
    },
    writeLearnedConventions: () => true,
    defaultSessionTitle: () => "New conversation",
  }, {
    filePath: disguisedPath,
    targetParent: path.join(tmp, "imports"),
    selectedAutomationIndexes: [0],
  });
  assert.equal(importResult.ok, true);
  assert.equal(fs.existsSync(path.join(importResult.workspacePath, "README.md")), true);
  assert.equal(importedTasks.length, 1);
  assert.equal(importedTasks[0].templates.length, 1);
  assert.equal(importedTasks[0].scope.projectId, importResult.projectId);
  assert.equal(importedTasks[0].scope.sessionId, importResult.sessionId);
  assert.equal(importResult.importedAutomations.every((task) => task.enabled === false), true);

  const installedSkills = [];
  const enabledSkills = [];
  const installedRuntimePacks = [];
  const installedApps = [];
  const appProjects = [];
  const appImport = await importWorkspacePackagePath({
    projectManager: {
      defaultPath: path.join(tmp, "default-app-workspace"),
      add: (targetPath) => {
        const project = { id: "project-app", name: path.basename(targetPath), path: targetPath };
        appProjects.push(project);
        return project;
      },
      rename: (_id, name) => {
        appProjects[0].name = name;
        return true;
      },
      getAppState: () => ({ projects: appProjects }),
    },
    sessionManager: {
      create: (projectId) => ({ id: `session-${projectId}`, projectId }),
    },
    scheduledTaskManager: {
      importPausedTemplates: () => ({ ok: true, tasks: [], skipped: [] }),
    },
    skillManager: {
      restoreWorkspaceSkillDir: () => null,
      getGloballyEnabledSkillIds: () => [],
      readInstalledManifest: (id) => id === "lily-browser-qa" ? { id } : null,
      installFromRegistry: async (id) => {
        installedSkills.push(id);
        return { ok: true };
      },
      setSkillEnabled: (id, enabled) => {
        enabledSkills.push({ id, enabled });
        return { ok: true };
      },
    },
    runtimePackInstaller: {
      installedRuntimePackIds: () => new Set(),
      installRuntimePack: async (id) => {
        installedRuntimePacks.push(id);
        return { ok: true };
      },
    },
    workspaceAppInstalls: {
      recordInstalled: (record) => {
        installedApps.push(record);
        return { id: record.manifest.appId };
      },
    },
    writeLearnedConventions: () => true,
    defaultSessionTitle: () => "New conversation",
  }, {
    filePath: appPath,
    targetParent: path.join(tmp, "app-imports"),
  });
  assert.equal(appImport.ok, true);
  assert.deepEqual(installedSkills, [], "installed but disabled skills are enabled without reinstalling");
  assert.deepEqual(enabledSkills, [{ id: "lily-browser-qa", enabled: true }]);
  assert.deepEqual(installedRuntimePacks, ["rembg"]);
  assert.equal(installedApps.length, 1, "local app import is recorded in installed apps");
  assert.deepEqual(installedApps[0].installedDependencies, {
    skills: [],
    runtimePacks: ["rembg"],
  });

  const removedProjects = [];
  const failedAutomationImport = await importWorkspacePackagePath({
    projectManager: {
      defaultPath: path.join(tmp, "failed-default"),
      add: (targetPath) => ({ id: "failed-project", name: "Failed", path: targetPath }),
      rename: () => true,
      remove: (id) => {
        removedProjects.push(id);
        return "OK";
      },
      getAppState: () => ({ projects: [] }),
    },
    sessionManager: {
      create: (projectId) => ({ id: `session-${projectId}`, projectId }),
      purgeProject: () => [],
    },
    scheduledTaskManager: {
      importPausedTemplates: () => ({ ok: false, error: "SAVE_FAILED" }),
    },
    skillManager: {
      restoreWorkspaceSkillDir: () => null,
      getGloballyEnabledSkillIds: () => [],
    },
    writeLearnedConventions: () => true,
    defaultSessionTitle: () => "New conversation",
  }, {
    filePath: disguisedPath,
    targetParent: path.join(tmp, "failed-imports"),
    selectedAutomationIndexes: [0],
  }).catch((error) => ({ ok: false, error: error.message }));
  assert.deepEqual(failedAutomationImport, {
    ok: false,
    error: "AUTOMATION_IMPORT_FAILED:SAVE_FAILED",
  });
  assert.deepEqual(removedProjects, ["failed-project"]);

  console.log("workspace-package-inspector: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
