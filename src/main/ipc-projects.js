"use strict";

const { ipcMain, dialog, shell } = require("electron");
const { ensureSessionRunner } = require("./ipc-utils");
const { defaultSessionTitle } = require("./session-manager");

function registerProjectHandlers(ctx) {
  const { mainWindow, projectManager, sessionManager, runnerPool } = ctx;

  ipcMain.handle("project:list", () => projectManager.getAppState());

  ipcMain.handle("project:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const project = projectManager.add(result.filePaths[0]);
    sessionManager.create(project.id, defaultSessionTitle());
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:switch", (_event, projectId) => {
    if (!projectManager.switchTo(projectId)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const sessions = sessionManager.listForProject(projectId);
    if (sessions.length > 0) {
      sessionManager.activeSessionId = sessions[0].id;
      sessionManager.save();
      ensureSessionRunner(ctx, sessions[0].id);
    }
    return { ok: true, state: projectManager.getAppState(), sessions };
  });

  ipcMain.handle("project:rename", (_event, projectId, name) => {
    const trimmed = String(name || "").trim();
    if (!projectManager.rename(projectId, trimmed)) return { ok: false, error: "INVALID" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:pin", (_event, projectId) => {
    if (!projectManager.togglePin(projectId)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:open", async (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const error = await shell.openPath(project.path);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("project:remove", (_event, projectId) => {
    const sessionIds = sessionManager.purgeProject(projectId);
    for (const sessionId of sessionIds) {
      runnerPool.terminateSession(sessionId);
    }
    const result = projectManager.remove(projectId);
    if (result !== "OK") return { ok: false, error: result };

    const active = projectManager.getActive();
    if (!active) {
      sessionManager.activeSessionId = null;
      sessionManager.save();
    } else {
      sessionManager.ensureDefaultForProject(active.id);
      if (!sessionManager.findById(sessionManager.activeSessionId)) {
        const remaining = sessionManager.listForProject(active.id);
        if (remaining.length > 0) {
          sessionManager.switchTo(remaining[0].id);
        }
      }
    }

    return { ok: true, state: projectManager.getAppState() };
  });

  // --- Workspace capability packs (.lilyspace.zip) ---------------------------
  ipcMain.handle("project:export-preview", (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const { previewExport } = require("./workspace-share");
    const skillManager = require("./skill-manager");
    return {
      ok: true,
      name: project.name,
      preview: previewExport(project.path),
      requiredSkills: skillManager.getGloballyEnabledSkillIds(),
    };
  });

  ipcMain.handle("project:export-pack", async (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出工作空间能力包",
      defaultPath: `${project.name}.lilyspace.zip`,
      filters: [{ name: "Lily Workspace Pack", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const { exportWorkspacePack } = require("./workspace-share");
      const { readLearnedConventions } = require("./learned-context");
      const skillManager = require("./skill-manager");
      const fs = require("node:fs");
      const buf = await exportWorkspacePack({
        rootPath: project.path,
        name: project.name,
        conventions: readLearnedConventions(project.id),
        requiredSkills: skillManager.getGloballyEnabledSkillIds(),
        exportedAt: new Date().toISOString(),
      });
      fs.writeFileSync(result.filePath, buf);
      return { ok: true, filePath: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("project:import-pack", async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "导入工作空间能力包",
      properties: ["openFile"],
      filters: [{ name: "Lily Workspace Pack", extensions: ["zip"] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

    // Let the user choose where the new workspace lands; canceling falls back
    // to the default workspace location.
    const dirPick = await dialog.showOpenDialog(mainWindow, {
      title: "选择导入到哪个文件夹",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "导入到此处",
    });
    const chosenParent = dirPick.canceled || !dirPick.filePaths.length ? null : dirPick.filePaths[0];

    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const { importWorkspacePack } = require("./workspace-share");
      const { writeLearnedConventions } = require("./learned-context");
      const skillManager = require("./skill-manager");

      const zipBuffer = fs.readFileSync(picked.filePaths[0]);
      const baseDir = chosenParent || path.dirname(projectManager.defaultPath || picked.filePaths[0]);
      const { manifest: peek } = await require("./workspace-share").readPackManifest(zipBuffer);
      let targetDir = path.join(baseDir, peek.name || "imported-workspace");
      let n = 2;
      while (fs.existsSync(targetDir)) targetDir = path.join(baseDir, `${peek.name}-${n++}`);

      const { manifest, conventions } = await importWorkspacePack(zipBuffer, targetDir);
      const project = projectManager.add(targetDir);
      if (manifest.name) projectManager.rename(project.id, manifest.name);
      if (conventions) writeLearnedConventions(project.id, conventions);
      sessionManager.create(project.id, defaultSessionTitle());

      const installed = new Set(skillManager.getGloballyEnabledSkillIds());
      const missingSkills = (manifest.requiredSkills || []).filter((id) => !installed.has(id));
      return {
        ok: true,
        state: projectManager.getAppState(),
        projectId: project.id,
        projectName: manifest.name || project.name,
        missingSkills,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerProjectHandlers };
