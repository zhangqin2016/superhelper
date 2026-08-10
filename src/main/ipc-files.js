"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { ipcMain, dialog, clipboard, Menu, app } = require("electron");
const FileStagingManager = require("./file-staging-manager");
const { fileStagingDir } = require("./config");
const { inspectLocalMediaPath } = require("./local-media-protocol");

// Keep this aligned with attachment-preview-model.js. Preview is deliberately
// bounded by bytes below, so common source/config files stay useful without
// treating arbitrary binary formats as text.
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".csv", ".json", ".yaml", ".yml", ".toml", ".xml",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
  ".html", ".htm", ".css", ".scss", ".less", ".sql", ".sh", ".bash", ".swift", ".kt", ".scala",
  ".lua", ".r", ".m", ".rb", ".php", ".vue", ".svelte",
]);
const DEFAULT_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 4 * 1024 * 1024;

function normalizePreviewPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("file://")) {
    try {
      return fileURLToPath(text);
    } catch {
      return "";
    }
  }
  return text;
}

function readTextPreview(payload = {}) {
  const filePath = normalizePreviewPath(
    typeof payload === "string" ? payload : payload.filePath || payload.path,
  );
  if (!filePath || !path.isAbsolute(filePath)) {
    return { ok: false, error: "INVALID_PATH" };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_PREVIEW_EXTENSIONS.has(ext)) {
    return { ok: false, error: "UNSUPPORTED_TYPE" };
  }
  const requested = Number(payload.maxBytes || DEFAULT_TEXT_PREVIEW_BYTES);
  const maxBytes = Math.min(
    Math.max(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TEXT_PREVIEW_BYTES, 1),
    MAX_TEXT_PREVIEW_BYTES,
  );
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: "NOT_FILE" };
    const bytesToRead = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      return {
        ok: true,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        bytes: stat.size,
        truncated: stat.size > bytesRead,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: err.message || "READ_FAILED" };
  }
}

function clipboardTextCandidates(value) {
  const text = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "\n");
  const candidates = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const match of text.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  return candidates;
}

function normalizeClipboardFilePath(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^["']|["']$/g, "");
  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text);
    } catch {
      return "";
    }
  }
  if (!path.isAbsolute(text)) return "";
  // Clipboard buffers are decoded as both UTF-8 and UTF-16 for cross-platform
  // compatibility. A wrong decode can collapse arbitrary bytes into "/" (or a
  // drive root). Never turn that false positive into an attachment for an
  // entire disk.
  if (path.parse(text).root === text) return "";
  return text;
}

function extractClipboardFilePaths(clip = clipboard) {
  const paths = new Set();
  const addCandidate = (value) => {
    for (const item of clipboardTextCandidates(value)) {
      const p = normalizeClipboardFilePath(item);
      if (p) paths.add(p);
    }
  };

  try {
    const bookmark = clip?.readBookmark?.();
    addCandidate(bookmark?.url || "");
  } catch {
    /* platform clipboard format unavailable */
  }
  try {
    addCandidate(clip?.readText?.() || "");
  } catch {
    /* platform clipboard format unavailable */
  }

  let formats = [];
  try {
    formats = Array.isArray(clip?.availableFormats?.()) ? clip.availableFormats() : [];
  } catch {
    formats = [];
  }
  for (const format of formats) {
    if (!/(file|filename|url|uri|path)/i.test(String(format || ""))) continue;
    let buffer = null;
    try {
      buffer = clip.readBuffer(format);
    } catch {
      buffer = null;
    }
    if (!buffer || !buffer.length) continue;
    addCandidate(buffer.toString("utf8"));
    addCandidate(buffer.toString("utf16le"));
  }

  return [...paths].filter((p) => {
    try {
      if (!fs.existsSync(p)) return false;
      const stat = fs.statSync(p);
      return stat.isFile() || stat.isDirectory();
    } catch {
      return false;
    }
  });
}

function stageClipboardFiles(stagingManager, clip = clipboard) {
  const staged = [];
  const errors = [];
  const paths = extractClipboardFilePaths(clip);
  for (const filePath of paths) {
    try {
      staged.push(stagingManager.stageFromPath(filePath));
    } catch (err) {
      errors.push({ path: filePath, error: err.message || "FILE_ERROR" });
    }
  }
  return { ok: true, files: staged, errors, empty: paths.length === 0 };
}

function attachmentPickerProperties(kind = "file") {
  return kind === "directory"
    ? ["openDirectory", "multiSelections"]
    : ["openFile", "multiSelections"];
}

function attachmentPickerLabels() {
  const locale = String(app?.getLocale?.() || "").toLowerCase();
  if (locale.startsWith("zh")) return { file: "选择文件", directory: "选择文件夹" };
  if (locale.startsWith("ar")) return { file: "اختيار ملفات", directory: "اختيار مجلد" };
  return { file: "Choose files", directory: "Choose folder" };
}

function chooseAttachmentKind(mainWindow) {
  if (!Menu?.buildFromTemplate) return Promise.resolve("file");
  const labels = attachmentPickerLabels();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const menu = Menu.buildFromTemplate([
      { label: labels.file, click: () => finish("file") },
      { label: labels.directory, click: () => finish("directory") },
    ]);
    menu.popup({ window: mainWindow, callback: () => finish("") });
  });
}

function registerFileHandlers(mainWindow, stagingManager) {
  ipcMain.handle("files:pick", async () => {
    const kind = await chooseAttachmentKind(mainWindow);
    if (!kind) return { ok: false, canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === "directory" ? "Select Folder" : "Select File",
      properties: attachmentPickerProperties(kind),
      ...(kind === "file" ? { filters: FileStagingManager.getFileFilters() } : {}),
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

  ipcMain.handle("files:stage", (_event, filePath, fileName) => {
    try {
      const meta = stagingManager.stageFromPath(filePath, fileName);
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

  ipcMain.handle("files:paste-clipboard", () => {
    try {
      return stageClipboardFiles(stagingManager);
    } catch (err) {
      return { ok: false, error: err.message || "CLIPBOARD_READ_FAILED" };
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

  ipcMain.handle("files:read-text", (_event, payload = {}) => readTextPreview(payload));
  ipcMain.handle("files:local-media-status", (_event, payload = {}) => inspectLocalMediaPath(payload.filePath || payload.path || payload));

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

module.exports = {
  attachmentPickerProperties,
  extractClipboardFilePaths,
  readTextPreview,
  registerFileHandlers,
  stageClipboardFiles,
};
