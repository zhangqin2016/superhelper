"use strict";

const { ipcMain, dialog } = require("electron");
const { importWorkspacePackagePath } = require("./workspace-import-service");
const { inspectWorkspacePackage } = require("./workspace-package-inspector");

function registerWorkspaceImportHandlers(ctx) {
  const { mainWindow } = ctx;

  ipcMain.handle("project:inspect-pack-path", async (_event, filePath) =>
    inspectWorkspacePackage(filePath));

  ipcMain.handle("project:pick-pack", async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Lily 工作空间或应用包",
      properties: ["openFile"],
      filters: [
        { name: "Lily Workspace Pack", extensions: ["zip"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (picked.canceled || !picked.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return inspectWorkspacePackage(picked.filePaths[0]);
  });

  ipcMain.handle("project:import-pack-path", async (_event, payload = {}) => {
    let targetParent = String(payload.targetParent || "").trim();
    if (!targetParent && payload.chooseTarget !== false) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: "选择导入到哪个文件夹",
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "导入到此处",
      });
      if (picked.canceled || !picked.filePaths.length) {
        return { ok: false, canceled: true };
      }
      targetParent = picked.filePaths[0];
    }
    try {
      return await importWorkspacePackagePath(ctx, {
        ...payload,
        targetParent: targetParent || undefined,
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

module.exports = { registerWorkspaceImportHandlers };
