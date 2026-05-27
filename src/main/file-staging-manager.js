"use strict";

/**
 * Manages file references for AI provider attachments.
 *
 * For files that already exist on disk (drag-drop, file picker), the original
 * path is returned directly — no copy is made.
 *
 * For clipboard pastes, the buffer is written to the OS temp directory.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { fileStagingDir } = require("./config");

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".csv", ".txt", ".md", ".rtf",
]);

const CODE_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".go", ".rs",
  ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".sh", ".bash",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm",
  ".css", ".scss", ".less", ".sql", ".swift", ".kt", ".scala",
  ".lua", ".r", ".m", ".vue", ".svelte",
]);

const ALL_SUPPORTED = new Set([
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...CODE_EXTENSIONS,
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};

// ---------------------------------------------------------------------------
// FileStagingManager
// ---------------------------------------------------------------------------

class FileStagingManager {
  constructor() {
    // Temp dir for pasted clipboard images
    this._pasteDir = path.join(os.tmpdir(), "ai-assistant-pastes");
    fs.mkdirSync(this._pasteDir, { recursive: true });
  }

  /**
   * Copy a file to the paste temp directory, keeping its original name.
   *
   * @param {string} srcPath  Absolute path to the source file.
   * @returns {Object} File metadata: { id, name, path, type, size, isImage }
   */
  stageFromPath(srcPath) {
    if (!fs.existsSync(srcPath)) {
      throw new Error("FILE_NOT_FOUND");
    }

    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) {
      throw new Error("NOT_A_FILE");
    }

    if (stat.size > MAX_FILE_SIZE) {
      throw new Error("FILE_TOO_LARGE");
    }

    const ext = path.extname(srcPath).toLowerCase();
    if (!ALL_SUPPORTED.has(ext)) {
      throw new Error("UNSUPPORTED_TYPE");
    }

    const name = path.basename(srcPath);

    // Copy to paste dir with original name, deduplicate if needed
    let destPath = path.join(this._pasteDir, name);
    let counter = 1;
    const base = path.basename(name, ext);
    while (fs.existsSync(destPath)) {
      destPath = path.join(this._pasteDir, `${base}-${counter}${ext}`);
      counter++;
    }

    fs.copyFileSync(srcPath, destPath);

    return {
      id: crypto.randomUUID(),
      name,
      path: destPath,
      type: ext.slice(1),
      size: stat.size,
      isImage: IMAGE_EXTENSIONS.has(ext),
    };
  }

  /**
   * Write a clipboard buffer to a temp file.
   *
   * @param {Buffer|Uint8Array} buffer  Raw file data.
   * @param {string} name              Original filename (e.g., "image.png").
   * @returns {Object} File metadata.
   */
  stageFromBuffer(buffer, name) {
    const ext = path.extname(name).toLowerCase() || ".png";
    if (!ALL_SUPPORTED.has(ext)) {
      throw new Error("UNSUPPORTED_TYPE");
    }

    const bufferData = Buffer.from(buffer);
    if (bufferData.length > MAX_FILE_SIZE) {
      throw new Error("FILE_TOO_LARGE");
    }

    // Write to temp dir with original name (deduplicate if needed)
    let destPath = path.join(this._pasteDir, name);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      const base = path.basename(name, ext);
      destPath = path.join(this._pasteDir, `${base}-${counter}${ext}`);
      counter++;
    }

    fs.writeFileSync(destPath, bufferData);

    const stat = fs.statSync(destPath);
    return {
      id: crypto.randomUUID(),
      name: name || `pasted-image${ext}`,
      path: destPath,
      type: ext.slice(1),
      size: stat.size,
      isImage: IMAGE_EXTENSIONS.has(ext),
    };
  }

  /**
   * Generate a base64 data URL thumbnail for an image file.
   *
   * @param {string} filePath  Absolute path to the file.
   * @returns {string|null} Data URL or null.
   */
  getThumbnail(filePath) {
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;

    try {
      const buffer = fs.readFileSync(filePath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
  }

  /**
   * Get image dimensions for a file.
   *
   * @param {string} filePath  Absolute path to the file.
   * @returns {{width: number, height: number}|null}
   */
  getDimensions(filePath) {
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;

    try {
      const { nativeImage } = require("electron");
      const img = nativeImage.createFromPath(filePath);
      const size = img.getSize();
      if (size.width > 0 && size.height > 0) {
        return { width: size.width, height: size.height };
      }
    } catch {
      // nativeImage not available or failed
    }
    return null;
  }

  /** No-op — files are at their original locations. */
  remove(_fileId) {}

  /** No-op — files are at their original locations. */
  cleanup(_ids) {}

  /**
   * Get the paste temp directory path.
   */
  getStagingDir() {
    return this._pasteDir;
  }

  static getFileFilters() {
    return [
      {
        name: "支持的文档",
        extensions: [
          ...IMAGE_EXTENSIONS,
          ...DOCUMENT_EXTENSIONS,
          ...CODE_EXTENSIONS,
        ].map((ext) => ext.slice(1)),
      },
      { name: "图片", extensions: [...IMAGE_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: "文档", extensions: [...DOCUMENT_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: "代码", extensions: [...CODE_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: "所有文件", extensions: ["*"] },
    ];
  }
}

module.exports = FileStagingManager;
