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

/**
 * Turn one Lily file ({path,name,isImage} from the composer, or {uri,mime})
 * into an OpenCode FilePart { type:"file", mime, filename, url }. Local files
 * become base64 `data:` URLs so OpenCode receives the actual bytes.
 */
function fileToPart(file) {
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
  try {
    const data = fs.readFileSync(filePath).toString("base64");
    return {
      type: "file",
      mime,
      filename: file.name || path.basename(filePath),
      url: `data:${mime};base64,${data}`,
    };
  } catch {
    return null;
  }
}

/**
 * Build the official OpenCode prompt body shape:
 * { agent, model?, parts:[...fileParts, textPart] }.
 */
function buildOpencodePromptBody(opts = {}) {
  const parts = [];
  const guidance = typeof opts.guidance === "string" ? opts.guidance.trim() : "";
  if (guidance) parts.push({ type: "text", text: guidance });
  if (Array.isArray(opts.files)) {
    for (const file of opts.files) {
      const part = fileToPart(file);
      if (part) parts.push(part);
    }
  }
  parts.push({ type: "text", text: String(opts.text || "") });
  const body = { agent: opts.agent || "build", parts };
  if (opts.model?.providerID && opts.model?.modelID) {
    body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };
  }
  return body;
}

module.exports = {
  buildOpencodePromptBody,
  fileToPart,
};
