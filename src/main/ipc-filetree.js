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

const { isTextFile } = require("./file-kinds");
const { findDiffEntry, removeAcceptedDiff, revertTurnChanges, undoRevertTurn } = require("./diff-capture");
const { resolveContainedPath } = require("./path-guard");

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

const SEARCH_SKIP_DIRS = new Set(["node_modules", "dist", "build", "release", "bundles", "__pycache__"]);
const SEARCH_MAX_DEPTH = 6;
const SEARCH_SCAN_CAP = 5000;

/** Bounded workspace file search for @-mentions in the composer. */
function searchWorkspaceFiles(rootPath, query, limit = 20) {
  const needle = String(query || "").toLowerCase();
  const matches = [];
  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > SEARCH_MAX_DEPTH || scanned > SEARCH_SCAN_CAP || matches.length >= limit) return;
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      if (matches.length >= limit || scanned > SEARCH_SCAN_CAP) return;
      scanned += 1;
      if (dirent.name.startsWith(".")) continue;
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(dirent.name)) walk(fullPath, depth + 1);
        continue;
      }
      const relPath = path.relative(rootPath, fullPath);
      if (!needle || relPath.toLowerCase().includes(needle)) {
        matches.push({ relPath, absPath: fullPath, name: dirent.name });
      }
    }
  };
  walk(rootPath, 0);
  return matches;
}

function registerFileTreeHandlers(ctx = {}) {
  const { sessionManager, projectManager } = ctx;

  // Resolve the project root that owns a session — write/delete handlers must
  // not touch anything outside it, no matter what path the renderer sends.
  function sessionProjectRoot(sessionId) {
    const session = sessionManager?.findById?.(sessionId);
    const project = session ? projectManager?.find?.(session.projectId) : null;
    return project?.path || null;
  }

  ipcMain.handle("filetree:search-files", (_event, { rootPath, query, limit }) => {
    try {
      if (!rootPath || typeof rootPath !== "string") return { ok: false, error: "INVALID_PATH" };
      const stat = fs.statSync(rootPath);
      if (!stat.isDirectory()) return { ok: false, error: "NOT_A_DIRECTORY" };
      const capped = Math.min(Number(limit) || 20, 50);
      return { ok: true, files: searchWorkspaceFiles(rootPath, query, capped) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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

  ipcMain.handle("filetree:accept-change", (_event, { sessionId, filePath }) => {
    removeAcceptedDiff(sessionId, filePath);
    return { ok: true };
  });

  // Rejecting a change restores the BEFORE state recorded by diff capture.
  // Original content and added/modified status come from the main-process diff
  // record — never from the renderer — and the target must be a file that diff
  // capture actually saw, inside the session's project root.
  ipcMain.handle("filetree:reject-change", async (_event, { sessionId, filePath }) => {
    try {
      const entry = findDiffEntry(sessionId, filePath);
      if (!entry) return { ok: false, error: "NO_DIFF_RECORD" };
      const root = sessionProjectRoot(sessionId);
      const target = resolveContainedPath(root, entry.filePath);
      if (!target) return { ok: false, error: "PATH_OUTSIDE_PROJECT" };
      if (entry.originalContent != null) {
        fs.writeFileSync(target, entry.originalContent, "utf-8");
      } else if (fs.existsSync(target)) {
        // Rejecting an added file means it should not exist.
        fs.unlinkSync(target);
      }
      removeAcceptedDiff(sessionId, filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("filetree:reveal", (_event, { filePath }) => {
    try {
      if (!filePath || typeof filePath !== "string" || !fs.existsSync(filePath)) {
        return { ok: false, error: "NOT_FOUND" };
      }
      const { shell } = require("electron");
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("filetree:revert-turn", (_event, { sessionId, turnId }) => {
    const results = revertTurnChanges(sessionId, turnId);
    const failed = results.filter((item) => !item.ok);
    return { ok: failed.length === 0, results, failed };
  });

  ipcMain.handle("filetree:unrevert-turn", (_event, { sessionId, turnId }) => {
    return undoRevertTurn(sessionId, turnId);
  });
}

module.exports = { registerFileTreeHandlers, searchWorkspaceFiles };
