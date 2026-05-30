"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ipcMain } = require("electron");

const ICON_MAP = {
  ".md": "doc", ".txt": "doc", ".json": "json",
  ".js": "code", ".ts": "code", ".py": "code",
  ".html": "code", ".css": "code",
  ".jpg": "img", ".jpeg": "img", ".png": "img", ".gif": "img", ".svg": "img", ".webp": "img",
  ".xlsx": "sheet", ".xls": "sheet", ".csv": "sheet",
  ".docx": "doc", ".doc": "doc", ".pdf": "pdf",
  ".zip": "archive", ".tar": "archive", ".gz": "archive",
};

const TEXT_EXTS = new Set([
  ".md", ".txt", ".json", ".js", ".ts", ".py", ".html", ".htm", ".css",
  ".csv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
  ".sh", ".bat", ".ps1", ".rb", ".java", ".go", ".rs", ".c", ".cpp",
  ".h", ".hpp", ".swift", ".kt",
]);

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTS.has(ext);
}

function classifyEntry(entryPath, stats) {
  const isDir = stats.isDirectory();
  const ext = isDir ? "" : path.extname(entryPath).toLowerCase();
  const iconType = ICON_MAP[ext] || "file";
  return {
    name: path.basename(entryPath),
    path: entryPath,
    isDirectory: isDir,
    size: isDir ? 0 : stats.size,
    ext,
    iconType,
  };
}

function registerFileTreeHandlers() {
  ipcMain.handle("filetree:list-dir", async (_event, { dirPath }) => {
    try {
      if (!dirPath || typeof dirPath !== "string") {
        return { ok: false, error: "INVALID_PATH" };
      }
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return { ok: false, error: "NOT_A_DIRECTORY" };
      }
      const names = fs.readdirSync(dirPath);
      const entries = [];
      for (const name of names) {
        if (name.startsWith(".")) continue;
        if (name === "node_modules") continue;
        const fullPath = path.join(dirPath, name);
        try {
          const s = fs.statSync(fullPath);
          entries.push(classifyEntry(fullPath, s));
        } catch {
          // skip inaccessible
        }
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { ok: true, entries };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("filetree:read-file", async (_event, { filePath }) => {
    try {
      if (!filePath || typeof filePath !== "string") {
        return { ok: false, error: "INVALID_PATH" };
      }
      const s = fs.statSync(filePath);
      if (!s.isFile()) {
        return { ok: false, error: "NOT_A_FILE" };
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return { ok: true, content, size: s.size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("filetree:restore-file", async (_event, { filePath, content }) => {
    try {
      if (!filePath || content == null) {
        return { ok: false, error: "INVALID_PAYLOAD" };
      }
      fs.writeFileSync(filePath, content, "utf-8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("filetree:accept-change", (_event, { sessionId, filePath }) => {
    const { removeAcceptedDiff } = require("./diff-capture");
    removeAcceptedDiff(sessionId, filePath);
    return { ok: true };
  });

  ipcMain.handle("filetree:reject-change", async (_event, { sessionId, filePath, content }) => {
    try {
      if (content != null) {
        fs.writeFileSync(filePath, content, "utf-8");
      }
      const { removeAcceptedDiff } = require("./diff-capture");
      removeAcceptedDiff(sessionId, filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerFileTreeHandlers, isTextFile };
