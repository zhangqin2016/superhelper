"use strict";

const { Notification } = require("electron");

function clip(text, max = 140) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * macOS / Windows 系统通知：仅在窗口不在前台时提示任务结束（类似 Codex）。
 */
function notifySessionFinished(mainWindow, { sessionTitle, ok, body, sessionId }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isFocused()) return;
  if (!Notification.isSupported()) return;

  const title = sessionTitle || "对话";
  const notification = new Notification({
    title: ok ? `${title} — 回复完成` : `${title} — 未完成`,
    body: clip(body) || (ok ? "点击查看回复" : "点击查看详情"),
    silent: false,
  });

  notification.on("click", () => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (sessionId) {
      mainWindow.webContents.send("assistant:focus-session", { sessionId });
    }
  });

  notification.show();
}

module.exports = { notifySessionFinished, clip };
