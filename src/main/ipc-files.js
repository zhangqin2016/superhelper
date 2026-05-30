"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ipcMain, dialog } = require("electron");
const FileStagingManager = require("./file-staging-manager");
const { fileStagingDir } = require("./config");

function registerFileHandlers(mainWindow, stagingManager) {
  ipcMain.handle("files:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择文件",
      properties: ["openFile", "multiSelections"],
      filters: FileStagingManager.getFileFilters(),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const staged = [];
    const errors = [];
    for (const filePath of result.filePaths) {
      try {
        const meta = stagingManager.stageFromPath(filePath);
        staged.push(meta);
      } catch (err) {
        errors.push({ path: filePath, error: err.message });
      }
    }
    return { ok: true, files: staged, errors };
  });

  ipcMain.handle("files:stage", (_event, filePath) => {
    try {
      const meta = stagingManager.stageFromPath(filePath);
      return { ok: true, file: meta };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("files:paste", (_event, buffer, fileName) => {
    try {
      const meta = stagingManager.stageFromBuffer(buffer, fileName);
      return { ok: true, file: meta };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("files:thumbnail", (_event, fileId) => {
    const dataUrl = stagingManager.getThumbnail(fileId);
    return { ok: true, dataUrl };
  });

  ipcMain.handle("files:dimensions", (_event, filePath) => {
    const dims = stagingManager.getDimensions(filePath);
    return dims ? { ok: true, ...dims } : { ok: false };
  });

  ipcMain.handle("files:clear-staging", () => {
    try {
      const dir = fileStagingDir();
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerFileHandlers };
