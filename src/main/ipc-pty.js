"use strict";

const { ipcMain, BrowserWindow } = require("electron");
const { PtySession } = require("./pty-session");

/** @type {Map<string, PtySession>} */
const sessions = new Map();

/**
 * @param {BrowserWindow} mainWindow
 */
function registerPtyHandlers(mainWindow) {
  // Create a new PTY session
  ipcMain.handle("pty:create", (_event, { sessionId, cwd, permissionMode, additionalDirs, configDir }) => {
    if (!sessionId) return { ok: false, error: "INVALID_SESSION" };

    const existing = sessions.get(sessionId);
    if (existing) {
      existing.kill();
      sessions.delete(sessionId);
    }

    const session = new PtySession(sessionId, {
      cwd: cwd || process.cwd(),
      permissionMode: permissionMode || "default",
      configDir: configDir || undefined,
    });

    session.on("pty-data", (data) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("pty:data", { sessionId, data });
      }
    });

    session.on("pty-exit", ({ exitCode, signal }) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("pty:exit", { sessionId, exitCode, signal });
      }
      sessions.delete(sessionId);
    });

    session.on("error", (err) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("pty:error", {
          sessionId,
          message: err?.message || String(err),
        });
      }
    });

    const created = session.spawn({
      cwd,
      additionalDirs: additionalDirs || [],
    });

    sessions.set(sessionId, session);
    return { ok: created, sessionId };
  });

  // Send user input to PTY
  ipcMain.on("pty:input", (_event, { sessionId, data }) => {
    const session = sessions.get(sessionId);
    if (session) session.write(data);
  });

  // Resize PTY terminal
  ipcMain.on("pty:resize", (_event, { sessionId, cols, rows }) => {
    const session = sessions.get(sessionId);
    if (session) session.resize(cols, rows);
  });

  // Kill a PTY session
  ipcMain.handle("pty:destroy", (_event, { sessionId }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.kill();
      sessions.delete(sessionId);
      return { ok: true };
    }
    return { ok: false, error: "NOT_FOUND" };
  });
}

module.exports = { registerPtyHandlers, sessions };
