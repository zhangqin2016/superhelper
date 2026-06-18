"use strict";

const RESULT_BLOCK_SCHEMA_VERSION = 1;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function normalizeExtension(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith(".") ? text : `.${text}`;
}

function extensionFromPath(filePath = "") {
  const match = String(filePath || "").match(/\.[^./\\]+$/);
  return normalizeExtension(match?.[0] || "");
}

function artifactTypeForArtifact(artifact = {}) {
  const mime = String(artifact.mimeType || "").toLowerCase();
  const ext = normalizeExtension(artifact.ext || extensionFromPath(artifact.path || artifact.relativePath || artifact.fileName));
  if (artifact.kind === "image" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime === "text/html" || ext === ".html" || ext === ".htm") return "html";
  return "file";
}

function artifactBlockId(artifact = {}) {
  return `artifact:${artifact.id || artifact.path || artifact.relativePath || Math.random()}`;
}

function contentBlockId(block = {}, index = 0) {
  return `content:${block.blockType || block.type || "block"}:${index}`;
}

function normalizeArtifactBlock(artifact = {}) {
  if (!artifact?.path) return null;
  const kind = artifactTypeForArtifact(artifact);
  return {
    id: artifactBlockId(artifact),
    type: "artifact",
    artifactType: kind,
    path: artifact.path,
    relativePath: artifact.relativePath || artifact.fileName || artifact.path,
    fileName: artifact.fileName || "",
    ext: artifact.ext || extensionFromPath(artifact.path || artifact.relativePath || artifact.fileName),
    mimeType: artifact.mimeType || "",
    bytes: artifact.bytes || 0,
    updatedAt: artifact.updatedAt || 0,
    source: artifact.source || "",
  };
}

function normalizeContentBlock(block = {}, index = 0) {
  if (block.blockType === "image" && block.data) {
    return {
      id: contentBlockId(block, index),
      type: "artifact",
      artifactType: "image",
      data: block.data,
      mimeType: block.mediaType || "image/png",
      alt: block.alt || "Assistant image",
      source: "content_block",
    };
  }
  return null;
}

function dedupeResultBlocks(blocks = []) {
  const seen = new Set();
  const out = [];
  for (const block of blocks) {
    if (!block?.type) continue;
    const key = block.path
      ? `${block.type}:${block.artifactType || ""}:${block.path}`
      : `${block.type}:${block.id || JSON.stringify(block).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

function buildTurnResultBlocks({ artifacts = [], contentBlocks = [], extraBlocks = [] } = {}) {
  const blocks = [];
  for (const block of extraBlocks || []) {
    if (block?.type) blocks.push(block);
  }
  for (const artifact of artifacts || []) {
    const block = normalizeArtifactBlock(artifact);
    if (block) blocks.push(block);
  }
  for (const [index, contentBlock] of (contentBlocks || []).entries()) {
    const block = normalizeContentBlock(contentBlock, index);
    if (block) blocks.push(block);
  }
  return dedupeResultBlocks(blocks);
}

module.exports = {
  RESULT_BLOCK_SCHEMA_VERSION,
  buildTurnResultBlocks,
  dedupeResultBlocks,
};
