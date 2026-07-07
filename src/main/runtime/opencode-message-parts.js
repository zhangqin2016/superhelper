"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

const DEFAULT_MAX_INLINE_FILE_BYTES =
  Number(process.env.LILY_OPENCODE_MAX_INLINE_FILE_BYTES) || 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_ATTACHMENT_CHARS =
  Number(process.env.LILY_OPENCODE_MAX_TEXT_ATTACHMENT_CHARS) || 80_000;

const TEXT_ATTACHMENT_EXTENSIONS = new Set([".svg"]);
const RASTER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PATH_ONLY_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildSkippedAttachmentNote(skipped = []) {
  if (!skipped.length) return "";
  const lines = skipped.map((item) => {
    const size = Number.isFinite(item.size) ? `, ${formatBytes(item.size)}` : "";
    const name = item.filename || path.basename(item.path || "") || "attachment";
    const source = item.path ? ` (source path: ${item.path})` : "";
    return `- ${name}${source}${size}: ${item.reason}`;
  });
  return [
    "[Attachment note]",
    "Some local files were not inlined into the OpenCode request to keep the desktop app responsive and avoid sending raw attachment bytes to the model service.",
    ...lines,
    "If document extraction succeeded, use the extracted text above. Otherwise use the source path with available file tools instead of asking the user to re-upload.",
  ].join("\n");
}

function buildAttachmentIndex(files = []) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!list.length) return "";
  const lines = list.slice(0, 20).map((file, index) => {
    const filePath = file.path || file.filePath || "";
    const name = file.name || file.filename || path.basename(filePath) || `attachment-${index + 1}`;
    let stat = null;
    if (filePath) {
      try {
        stat = fs.statSync(filePath);
      } catch {
        stat = null;
      }
    }
    return [
      `- ${name}`,
      filePath ? `  source path: ${filePath}` : "  source path: unavailable",
      file.sourcePath && file.sourcePath !== filePath ? `  original path: ${file.sourcePath}` : "",
      typeof file.isImage === "boolean" ? `  image: ${file.isImage ? "yes" : "no"}` : "",
      stat?.isFile?.() ? `  size: ${formatBytes(stat.size)}` : "",
      filePath ? `  readable now: ${stat?.isFile?.() ? "yes" : "no"}` : "",
    ].filter(Boolean).join("\n");
  });
  const omitted = list.length > 20 ? `\n\n${list.length - 20} more attachment(s) omitted from this index.` : "";
  return [
    "[Attachment index]",
    "Use these exact local source paths when a task requires inspecting or editing an attached file. Do not search the workspace by filename unless the listed source path is missing or unreadable.",
    ...lines,
    omitted,
  ].filter(Boolean).join("\n");
}

function truncateAttachmentText(text, limit = DEFAULT_MAX_TEXT_ATTACHMENT_CHARS) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Attachment text truncated, original length: ${value.length} characters]`;
}

function textFenceForExtension(ext) {
  if (ext === ".svg") return "svg";
  return "";
}

function fileExtension(file = {}, filePath = "") {
  const pathExt = path.extname(filePath || "").toLowerCase();
  if (pathExt) return pathExt;
  return path.extname(file.name || file.filename || "").toLowerCase();
}

function documentMimeLike(value = "") {
  const mime = String(value || "").toLowerCase();
  return Boolean(mime) && (
    mime === "application/pdf" ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("vnd.ms-") ||
    mime.includes("wordprocessingml") ||
    mime.includes("spreadsheetml") ||
    mime.includes("presentationml") ||
    mime.includes("opendocument") ||
    mime === "application/rtf" ||
    mime === "text/rtf"
  );
}

function isPathOnlyDocumentAttachment(file = {}, filePath = "") {
  const ext = fileExtension(file, filePath);
  if (PATH_ONLY_DOCUMENT_EXTENSIONS.has(ext)) return true;
  return documentMimeLike(file.mime || file.type || file.mimeType || file.mediaType || "");
}

function imageMimeLike(value = "") {
  const mime = String(value || "").toLowerCase();
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

function isRasterImageAttachment(file = {}, filePath = "", mime = "") {
  const ext = fileExtension(file, filePath);
  if (RASTER_IMAGE_EXTENSIONS.has(ext)) return true;
  return imageMimeLike(mime || file.mime || file.type || file.mimeType || file.mediaType || "");
}

function isSafeInlineFilePartMime(mime = "") {
  const value = String(mime || "").toLowerCase();
  if (value.startsWith("image/")) return true;
  if (value.startsWith("text/")) return true;
  return [
    "application/json",
    "application/geo+json",
    "application/x-ndjson",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-javascript",
  ].includes(value);
}

function skipPathOnlyAttachment(filePath, filename, opts = {}, reason = "not an explicitly safe inline type; use the source path with local tools") {
  if (typeof opts.onSkip === "function") {
    opts.onSkip({ path: filePath, filename, reason });
  }
}

function skipImageAttachment(filePath, filename, opts = {}) {
  skipPathOnlyAttachment(
    filePath,
    filename,
    opts,
    "image handled through Lily vision extraction/source path, not uploaded as a raw model file part",
  );
}

function fileToTextAttachment(file, opts = {}) {
  if (!file || typeof file !== "object") return null;
  const filePath = file.path || file.filePath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = fileExtension(file, filePath);
  if (!TEXT_ATTACHMENT_EXTENSIONS.has(ext)) return null;
  const filename = file.name || path.basename(filePath);
  const maxInlineFileBytes =
    Number.isFinite(opts.maxInlineFileBytes) && opts.maxInlineFileBytes >= 0
      ? opts.maxInlineFileBytes
      : DEFAULT_MAX_INLINE_FILE_BYTES;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxInlineFileBytes) {
      if (typeof opts.onSkip === "function") {
        opts.onSkip({
          path: filePath,
          filename,
          size: stat.size,
          reason: `larger than text inline limit ${formatBytes(maxInlineFileBytes)}`,
        });
      }
      return null;
    }
    const source = fs.readFileSync(filePath, "utf8");
    const fence = textFenceForExtension(ext);
    const body = truncateAttachmentText(source, opts.maxTextAttachmentChars);
    return [
      `[Attached ${ext.slice(1).toUpperCase()}: ${filename}]`,
      `Source path: ${filePath}`,
      "",
      `\`\`\`${fence}`,
      body,
      "```",
    ].join("\n");
  } catch {
    return null;
  }
}

/**
 * Turn one Lily file ({path,name,isImage} from the composer, or {uri,mime})
 * into an OpenCode FilePart { type:"file", mime, filename, url }. Local files
 * become base64 `data:` URLs only for explicitly allowed inline-safe types.
 * Raster images require native-vision opt-in; otherwise Lily sends the vision
 * extraction/path context instead of raw image bytes.
 */
function fileToPart(file, opts = {}) {
  if (!file || typeof file !== "object") return null;
  if (file.uri && file.mime) {
    if (isRasterImageAttachment(file, file.path || file.filePath || "", file.mime) && opts.allowImageFileParts !== true) {
      skipImageAttachment(file.path || file.filePath || "", file.name || file.filename || "", opts);
      return null;
    }
    if (isPathOnlyDocumentAttachment(file)) {
      skipPathOnlyAttachment(
        file.path || file.filePath || "",
        file.name || file.filename || "",
        opts,
        "document handled through Lily document extraction/source path, not uploaded as a raw model file part",
      );
      return null;
    }
    if (!isSafeInlineFilePartMime(file.mime)) {
      skipPathOnlyAttachment(file.path || file.filePath || "", file.name || file.filename || "", opts);
      return null;
    }
    return {
      type: "file",
      url: file.uri,
      mime: file.mime,
      ...(file.name ? { filename: file.name } : {}),
    };
  }
  const filePath = file.path || file.filePath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = fileExtension(file, filePath);
  const mime = file.mime || FILE_MIME[ext] || "application/octet-stream";
  const filename = file.name || path.basename(filePath);
  if (TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
    if (typeof opts.onSkip === "function") {
      opts.onSkip({
        path: filePath,
        filename,
        reason: `${ext.slice(1)}_text_attachment`,
      });
    }
    return null;
  }
  if (isPathOnlyDocumentAttachment(file, filePath)) {
    skipPathOnlyAttachment(
      filePath,
      filename,
      opts,
      "document handled through Lily document extraction/source path, not uploaded as a raw model file part",
    );
    return null;
  }
  if (isRasterImageAttachment(file, filePath, mime) && opts.allowImageFileParts !== true) {
    skipImageAttachment(filePath, filename, opts);
    return null;
  }
  if (!isSafeInlineFilePartMime(mime)) {
    skipPathOnlyAttachment(filePath, filename, opts);
    return null;
  }
  const maxInlineFileBytes =
    Number.isFinite(opts.maxInlineFileBytes) && opts.maxInlineFileBytes >= 0
      ? opts.maxInlineFileBytes
      : DEFAULT_MAX_INLINE_FILE_BYTES;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxInlineFileBytes) {
      if (typeof opts.onSkip === "function") {
        opts.onSkip({
          path: filePath,
          filename,
          size: stat.size,
          reason: `larger than inline limit ${formatBytes(maxInlineFileBytes)}`,
        });
      }
      return null;
    }
    const data = fs.readFileSync(filePath).toString("base64");
    return {
      type: "file",
      mime,
      filename,
      url: `data:${mime};base64,${data}`,
    };
  } catch {
    return null;
  }
}

/**
 * Build the official OpenCode prompt body shape:
 * { agent, system?, model?, parts:[...fileParts, textPart] }.
 */
function buildOpencodePromptBody(opts = {}) {
  const parts = [];
  const skipped = [];
  const textAttachments = [];
  const guidance = typeof opts.guidance === "string" ? opts.guidance.trim() : "";
  if (Array.isArray(opts.files)) {
    for (const file of opts.files) {
      const textAttachment = fileToTextAttachment(file, {
        maxInlineFileBytes: opts.maxInlineFileBytes,
        maxTextAttachmentChars: opts.maxTextAttachmentChars,
        onSkip: (item) => skipped.push(item),
      });
      if (textAttachment) {
        textAttachments.push(textAttachment);
        continue;
      }
      const part = fileToPart(file, {
        maxInlineFileBytes: opts.maxInlineFileBytes,
        allowImageFileParts: opts.allowImageFileParts === true,
        onSkip: (item) => skipped.push(item),
      });
      if (part) parts.push(part);
    }
  }
  const indexNote = buildAttachmentIndex(opts.files);
  const note = buildSkippedAttachmentNote(skipped);
  const text = [String(opts.text || ""), indexNote, ...textAttachments, note].filter(Boolean).join("\n\n");
  parts.push({ type: "text", text });
  const body = { agent: opts.agent || "build", parts };
  if (guidance) body.system = guidance;
  if (opts.model?.providerID && opts.model?.modelID) {
    body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };
  }
  return body;
}

module.exports = {
  DEFAULT_MAX_INLINE_FILE_BYTES,
  DEFAULT_MAX_TEXT_ATTACHMENT_CHARS,
  buildSkippedAttachmentNote,
  buildAttachmentIndex,
  buildOpencodePromptBody,
  fileToTextAttachment,
  fileToPart,
};
