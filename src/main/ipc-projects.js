"use strict";

const { ipcMain, dialog, shell } = require("electron");
const { ensureSessionRunner } = require("./ipc-utils");

function registerProjectHandlers(ctx) {
  const { mainWindow, projectManager, sessionManager, runnerPool } = ctx;

  ipcMain.handle("project:list", () => projectManager.getAppState());

  ipcMain.handle("project:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const project = projectManager.add(result.filePaths[0]);
    sessionManager.create(project.id, "默认对话");
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
}

module.exports = { registerProjectHandlers };
