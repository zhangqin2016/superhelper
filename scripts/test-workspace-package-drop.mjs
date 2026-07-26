#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { routeDroppedFiles } = await import(
  "../src/renderer/modules/workspace-package-drop.js"
);

const appFile = { name: "demo.lilyspace.zip" };
const noteFile = { name: "notes.txt" };
const attachFile = { name: "attach-app.zip" };
const paths = new Map([
  [appFile, "/tmp/demo.lilyspace.zip"],
  [noteFile, "/tmp/notes.txt"],
  [attachFile, "/tmp/attach-app.zip"],
]);
const imported = [];
const attached = [];
const reviews = [];

const result = await routeDroppedFiles([appFile, noteFile, attachFile], {
  resolvePath: async (file) => paths.get(file) || "",
  inspectPath: async (filePath) => {
    if (filePath.endsWith("notes.txt")) {
      return { ok: true, recognized: false, reason: "NOT_A_WORKSPACE_PACK" };
    }
    return {
      ok: true,
      recognized: true,
      filePath,
      kind: "lily-workspace-app",
      name: filePath.includes("attach") ? "Attach app" : "Demo app",
      automationTemplates: [{ title: "Daily report" }],
    };
  },
  reviewPackage: async (inspection) => {
    reviews.push(inspection.name);
    return inspection.name === "Attach app"
      ? { action: "attach" }
      : { action: "import", selectedAutomationIndexes: [0] };
  },
  importPackage: async (payload) => {
    imported.push(payload);
    return { ok: true, projectId: "project-new" };
  },
  attachFiles: async (files) => {
    attached.push(...files);
    return files.length;
  },
});

assert.deepEqual(reviews, ["Demo app", "Attach app"]);
assert.equal(imported.length, 1);
assert.equal(imported[0].filePath, "/tmp/demo.lilyspace.zip");
assert.deepEqual(imported[0].selectedAutomationIndexes, [0]);
assert.deepEqual(attached, [noteFile, attachFile]);
assert.equal(result.imports.length, 1);
assert.equal(result.attachedCount, 2);

const canceledFile = { name: "cancel.zip" };
let canceledAttached = false;
const canceled = await routeDroppedFiles([canceledFile], {
  resolvePath: async () => "/tmp/cancel.zip",
  inspectPath: async () => ({
    ok: true,
    recognized: true,
    kind: "lily-workspace-pack",
    name: "Cancel me",
    automationTemplates: [],
  }),
  reviewPackage: async () => ({ action: "cancel" }),
  importPackage: async () => {
    throw new Error("must not import canceled package");
  },
  attachFiles: async () => {
    canceledAttached = true;
  },
});
assert.equal(canceled.canceledCount, 1);
assert.equal(canceledAttached, false, "cancel means neither import nor attach");

const fallbackFile = { name: "still-attach.zip" };
const fallbackAttachments = [];
const fallback = await routeDroppedFiles([fallbackFile], {
  resolvePath: async () => "/tmp/still-attach.zip",
  inspectPath: async () => {
    throw new Error("main process temporarily unavailable");
  },
  reviewPackage: async () => {
    throw new Error("unrecognized files must not open a review");
  },
  importPackage: async () => {
    throw new Error("unrecognized files must not import");
  },
  attachFiles: async (files) => {
    fallbackAttachments.push(...files);
    return files.length;
  },
});
assert.deepEqual(fallbackAttachments, [fallbackFile]);
assert.equal(fallback.attachedCount, 1, "inspection failure preserves ordinary attachment behavior");

const ipcProjects = fs.readFileSync(
  path.join(process.cwd(), "src/main/ipc-projects.js"),
  "utf8",
);
const ipcImport = fs.readFileSync(
  path.join(process.cwd(), "src/main/ipc-workspace-import.js"),
  "utf8",
);
const preload = fs.readFileSync(
  path.join(process.cwd(), "src/preload.js"),
  "utf8",
);
const fileHandler = fs.readFileSync(
  path.join(process.cwd(), "src/renderer/modules/file-handler.js"),
  "utf8",
);
const projectTree = fs.readFileSync(
  path.join(process.cwd(), "src/renderer/modules/project-tree.js"),
  "utf8",
);
const packageReview = fs.readFileSync(
  path.join(process.cwd(), "src/renderer/modules/workspace-package-review.js"),
  "utf8",
);
assert.match(ipcProjects, /registerWorkspaceImportHandlers\(ctx\)/);
assert.match(ipcImport, /project:inspect-pack-path/);
assert.match(ipcImport, /project:pick-pack/);
assert.match(ipcImport, /project:import-pack-path/);
assert.match(ipcImport, /importWorkspacePackagePath/);
assert.match(preload, /inspectWorkspacePackage/);
assert.match(preload, /pickWorkspacePackage/);
assert.match(preload, /importWorkspacePackagePath/);
assert.match(fileHandler, /routeDroppedFiles/);
assert.match(fileHandler, /reviewWorkspacePackage/);
assert.match(projectTree, /pickWorkspacePackage/);
assert.match(projectTree, /reviewWorkspacePackage/);
assert.match(packageReview, /checkbox\.checked = false/);
assert.match(packageReview, /selectedAutomationIndexes/);

console.log("workspace-package-drop: ok");
