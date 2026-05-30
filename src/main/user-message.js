"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};

const DOCUMENT_EXTENSIONS = new Set([".pdf"]);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function mimeForPath(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * @param {string} text
 * @param {Array<{ path?: string, name?: string, isImage?: boolean }>} files
 */
function buildUserContentBlocks(text, files = []) {
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  const trimmed = String(text || "").trim();
  if (trimmed) blocks.push({ type: "text", text: trimmed });

  for (const f of files) {
    if (!f?.path || !fs.existsSync(f.path)) continue;
    const ext = path.extname(f.path).toLowerCase();
    const isImage = Boolean(f.isImage || IMAGE_EXTENSIONS.has(ext));

    if (isImage) {
      try {
        const data = fs.readFileSync(f.path).toString("base64");
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mimeForPath(f.path),
            data,
          },
        });
      } catch {
        blocks.push({
          type: "text",
          text: `[图片: ${f.name || path.basename(f.path)}] ${f.path}`,
        });
      }
      continue;
    }

    if (DOCUMENT_EXTENSIONS.has(ext)) {
      try {
        const stat = fs.statSync(f.path);
        if (stat.size <= MAX_DOCUMENT_BYTES) {
          const data = fs.readFileSync(f.path).toString("base64");
          blocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: mimeForPath(f.path),
              data,
            },
          });
          continue;
        }
      } catch {
        // fall through to text path
      }
    }

    const label = f.name || path.basename(f.path);
    blocks.push({
      type: "text",
      text: `[附件: ${label}]\n${f.path}`,
    });
  }

  return blocks;
}

/**
 * @param {{ text?: string, files?: Array<Record<string, unknown>>, sessionId?: string | null, parentToolUseId?: string | null }} opts
 */
function buildUserMessagePayload(opts = {}) {
  const content = buildUserContentBlocks(opts.text, opts.files || []);
  if (content.length === 0) return null;

  /** @type {Record<string, unknown>} */
  const payload = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: opts.parentToolUseId ?? null,
  };
  if (opts.sessionId) payload.session_id = opts.sessionId;
  return payload;
}

function hasSendableContent(text, files = []) {
  if (String(text || "").trim()) return true;
  return (files || []).some((f) => f?.path && fs.existsSync(f.path));
}

module.exports = {
  buildUserContentBlocks,
  buildUserMessagePayload,
  hasSendableContent,
};
