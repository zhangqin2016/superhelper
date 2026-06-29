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
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

const DEFAULT_MAX_INLINE_FILE_BYTES =
  Number(process.env.LILY_OPENCODE_MAX_INLINE_FILE_BYTES) || 8 * 1024 * 1024;

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
    return `- ${item.filename || item.path || "attachment"}${size}: ${item.reason}`;
  });
  return [
    "[Attachment note]",
    "Some local files were not inlined into the OpenCode request to keep the desktop app responsive.",
    ...lines,
    "If document extraction succeeded, use the extracted text above. Otherwise ask the user to split or compress the file.",
  ].join("\n");
}

/**
 * Turn one Lily file ({path,name,isImage} from the composer, or {uri,mime})
 * into an OpenCode FilePart { type:"file", mime, filename, url }. Local files
 * become base64 `data:` URLs so OpenCode receives the actual bytes.
 */
function fileToPart(file, opts = {}) {
  if (!file || typeof file !== "object") return null;
  if (file.uri && file.mime) {
    return {
      type: "file",
      url: file.uri,
      mime: file.mime,
      ...(file.name ? { filename: file.name } : {}),
    };
  }
  const filePath = file.path || file.filePath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const mime = file.mime || FILE_MIME[ext] || "application/octet-stream";
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
  const guidance = typeof opts.guidance === "string" ? opts.guidance.trim() : "";
  if (Array.isArray(opts.files)) {
    for (const file of opts.files) {
      const part = fileToPart(file, {
        maxInlineFileBytes: opts.maxInlineFileBytes,
        onSkip: (item) => skipped.push(item),
      });
      if (part) parts.push(part);
    }
  }
  const note = buildSkippedAttachmentNote(skipped);
  const text = [String(opts.text || ""), note].filter(Boolean).join("\n\n");
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
  buildSkippedAttachmentNote,
  buildOpencodePromptBody,
  fileToPart,
};
