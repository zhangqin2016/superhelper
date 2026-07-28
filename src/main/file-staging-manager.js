"use strict";

/**
 * Manages file references for AI provider attachments.
 *
 * Small files are copied into the app staging directory for stability. Large
 * path-backed files are kept as in-place references so attaching them does not
 * block the UI or duplicate gigabytes of data.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fileStagingDir } = require("./config");
const {
  detectArchiveFormat,
  isArchiveFilePath,
  isSemanticZipContainerPath,
} = require("./mcp/archive-intelligence");

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

const COPY_INTO_STAGING_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PATHLESS_BUFFER_BYTES = 20 * 1024 * 1024;

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

const ARCHIVE_SUFFIXES = [
  ".tar.gz", ".tar.bz2", ".tar.xz",
  ".zip", ".7z", ".rar", ".tar", ".tgz", ".tbz", ".tbz2", ".txz",
  ".gz", ".bz2", ".xz",
];

function archiveExtension(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return ARCHIVE_SUFFIXES.find((suffix) => lower.endsWith(suffix)) || "";
}

function pathReadable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// FileStagingManager
// ---------------------------------------------------------------------------

class FileStagingManager {
  constructor() {
    this._stagingDir = fileStagingDir();
    fs.mkdirSync(this._stagingDir, { recursive: true });
  }

  /**
   * Stage a file path, keeping small files in the app staging directory and
   * referencing large files in place.
   *
   * @param {string} srcPath  Absolute path to the source file.
   * @returns {Object} File metadata: { id, name, path, type, size, isImage }
   */
  stageFromPath(srcPath) {
    if (!fs.existsSync(srcPath)) {
      throw new Error("FILE_NOT_FOUND");
    }

    const stat = fs.statSync(srcPath);
    const isDirectory = stat.isDirectory();
    if (!stat.isFile() && !isDirectory) throw new Error("UNSUPPORTED_PATH");
    const ext = path.extname(srcPath).toLowerCase();
    let supported = stat.isFile() && ALL_SUPPORTED.has(ext);
    const archiveExt = archiveExtension(srcPath);
    const detectedArchiveFormat = stat.isFile() ? detectArchiveFormat(srcPath) : "";
    const archiveFormat = detectedArchiveFormat && !isSemanticZipContainerPath(srcPath)
      ? detectedArchiveFormat
      : "";
    if (archiveFormat) supported = false;
    const kind = isDirectory
      ? "directory"
      : archiveFormat
        ? "archive"
        : supported
          ? (IMAGE_EXTENSIONS.has(ext) ? "image" : "file")
          : "binary";
    const name = path.basename(srcPath);
    let storedPath = srcPath;
    let staged = false;

    if (supported && stat.size <= COPY_INTO_STAGING_MAX_BYTES) {
      let destPath = path.join(this._stagingDir, name);
      let counter = 1;
      const base = path.basename(name, ext);
      while (fs.existsSync(destPath)) {
        destPath = path.join(this._stagingDir, `${base}-${counter}${ext}`);
        counter++;
      }

      fs.copyFileSync(srcPath, destPath);
      storedPath = destPath;
      staged = true;
    }

    return {
      id: crypto.randomUUID(),
      name,
      path: storedPath,
      sourcePath: srcPath,
      type: isDirectory ? "directory" : archiveFormat || (archiveExt || ext).replace(/^\./, "") || "file",
      extension: archiveExt || ext,
      kind,
      size: isDirectory ? 0 : stat.size,
      staged,
      pathOnly: isDirectory || !supported,
      readable: pathReadable(srcPath),
      isDirectory,
      isImage: !archiveFormat && IMAGE_EXTENSIONS.has(ext),
    };
  }

  /**
   * Write a clipboard buffer to the staging directory.
   *
   * @param {Buffer|Uint8Array} buffer  Raw file data.
   * @param {string} name              Original filename (e.g., "image.png").
   * @returns {Object} File metadata.
   */
  stageFromBuffer(buffer, name) {
    const safeName = name || "pasted-image.png";
    const ext = path.extname(safeName).toLowerCase() || ".png";
    if (!ALL_SUPPORTED.has(ext)) {
      throw new Error("UNSUPPORTED_TYPE");
    }

    const bufferData = Buffer.from(buffer);
    if (bufferData.length > MAX_PATHLESS_BUFFER_BYTES) {
      throw new Error("FILE_TOO_LARGE");
    }

    let destPath = path.join(this._stagingDir, safeName);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      const base = path.basename(safeName, ext);
      destPath = path.join(this._stagingDir, `${base}-${counter}${ext}`);
      counter++;
    }

    fs.writeFileSync(destPath, bufferData);

    const stat = fs.statSync(destPath);
    return {
      id: crypto.randomUUID(),
      name: safeName,
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
    if (isArchiveFilePath(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > COPY_INTO_STAGING_MAX_BYTES) return null;
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
    if (isArchiveFilePath(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > COPY_INTO_STAGING_MAX_BYTES) return null;
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
   * Get the staging directory path.
   */
  getStagingDir() {
    return this._stagingDir;
  }

  static getFileFilters() {
    return [
      {
        name: "Supported Documents",
        extensions: [
          ...IMAGE_EXTENSIONS,
          ...DOCUMENT_EXTENSIONS,
          ...CODE_EXTENSIONS,
        ].map((ext) => ext.slice(1)),
      },
      { name: "Images", extensions: [...IMAGE_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: "Documents", extensions: [...DOCUMENT_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: "Code", extensions: [...CODE_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: "All Files", extensions: ["*"] },
    ];
  }
}

module.exports = FileStagingManager;
