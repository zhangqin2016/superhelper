#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-add-existing-"));
const selectedPath = path.join(temp, "existing-folder");
fs.mkdirSync(selectedPath, { recursive: true });

const originalLoad = Module._load;
const handlers = new Map();
const dialog = {
  async showOpenDialog() {
    return { canceled: false, filePaths: [selectedPath] };
  },
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      dialog,
      shell: {},
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerProjectHandlers } = require(path.join(ROOT, "src/main/ipc-projects.js"));
  const projects = [
    { id: "old-project", name: "Old", path: path.join(temp, "old") },
    { id: "selected-project", name: "Selected", path: selectedPath },
  ];
  fs.mkdirSync(projects[0].path, { recursive: true });
  let activeProjectId = projects[0].id;
  let activeSessionId = "old-session";
  const sessions = {
    "old-project": [{ id: "old-session", projectId: "old-project" }],
    "selected-project": [{ id: "selected-session", projectId: "selected-project" }],
  };
  const switchCalls = [];
  const projectManager = {
    defaultPath: path.join(temp, "default"),
    getAppState: () => ({
      activeProjectId,
      projects: projects.map(({ id, name, path: workspacePath }) => ({ id, name, path: workspacePath })),
    }),
    hasPath: (workspacePath) => projects.some((project) => project.path === workspacePath),
    add(workspacePath) {
      const project = projects.find((item) => item.path === workspacePath);
      activeProjectId = project.id;
      return project;
    },
    find(projectId) {
      return projects.find((project) => project.id === projectId) || null;
    },
    reorder() {},
    rename() { return true; },
    remove() { return "OK"; },
  };
  const sessionManager = {
    listForProject: (projectId) => sessions[projectId] || [],
    findById: (sessionId) => Object.values(sessions).flat().find((session) => session.id === sessionId) || null,
    switchTo(sessionId) {
      activeSessionId = sessionId;
      switchCalls.push(sessionId);
    },
    save() {},
    saveImmediate() {},
    create() { throw new Error("duplicate workspace should reuse its session"); },
  };

  registerProjectHandlers({
    mainWindow: {},
    projectManager,
    sessionManager,
    runnerPool: { get: () => null, terminateSession() {} },
  });

  const result = await handlers.get("project:add")({});
  assert.equal(result.ok, true);
  assert.equal(result.existed, true);
  assert.equal(activeProjectId, "selected-project");
  assert.equal(activeSessionId, "selected-session", "re-adding a workspace must select one of its sessions");
  assert.deepEqual(switchCalls, ["selected-session"]);
} finally {
  Module._load = originalLoad;
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("workspace-add-existing: ok");
