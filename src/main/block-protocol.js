"use strict";

/**
 * Typed result-block protocol — the single contract between what the agent
 * runtime PRODUCES and what the UI RENDERS.
 *
 * The platform's content surface (markdown, code, tables, charts, images, PDFs,
 * HTML, forms, …) grows over time. Keeping it a versioned, declarative block
 * model means adding a content type is "one block type + one renderer" and
 * never touches the core. The UI is a pure function of these blocks; nothing
 * downstream re-parses model text.
 *
 * Forward-compatibility is deliberate: an unknown `type` is NOT rejected — a
 * newer producer may emit a block an older renderer doesn't know yet, and the
 * renderer falls back gracefully. BLOCK_TYPES documents the known set and is
 * used by producers, not as a gate.
 */

const BLOCK_SCHEMA_VERSION = 2;

const BLOCK_TYPES = Object.freeze({
  MARKDOWN: "markdown",
  TEXT: "text",
  CODE: "code",
  DIFF: "diff",
  TABLE: "table",
  CHART: "chart",
  IMAGE: "image",
  PDF: "pdf",
  HTML: "html",
  FILE: "file",
  VIDEO: "video",
  AUDIO: "audio",
  FORM: "form",
  ACTION_RESULT: "action_result",
  ARTIFACT: "artifact", // generic file artifact; artifactType refines it
});

const KNOWN_TYPES = new Set(Object.values(BLOCK_TYPES));

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

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
  const ext = normalizeExtension(
    artifact.ext || extensionFromPath(artifact.path || artifact.relativePath || artifact.fileName),
  );
  if (artifact.kind === "image" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return BLOCK_TYPES.IMAGE;
  if (artifact.kind === "video" || mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return BLOCK_TYPES.VIDEO;
  if (artifact.kind === "audio" || mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) return BLOCK_TYPES.AUDIO;
  if (mime === "application/pdf" || ext === ".pdf") return BLOCK_TYPES.PDF;
  if (mime === "text/markdown" || ext === ".md" || ext === ".markdown") return BLOCK_TYPES.MARKDOWN;
  if (mime === "text/html" || ext === ".html" || ext === ".htm") return BLOCK_TYPES.HTML;
  return BLOCK_TYPES.FILE;
}

let autoId = 0;
function ensureId(block) {
  if (block.id) return block.id;
  if (block.path) return `artifact:${block.path}`;
  autoId += 1;
  return `block:${block.type}:${autoId}`;
}

/**
 * Validate/coerce a raw block into a canonical one. Returns null only when the
 * block has no usable `type` — unknown types pass through (forward-compatible).
 */
function normalizeBlock(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "").trim();
  if (!type) return null;
  return { ...raw, type, id: ensureId({ ...raw, type }) };
}

function normalizeArtifactBlock(artifact = {}) {
  if (!artifact?.path) return null;
  return normalizeBlock({
    id: artifact.id || artifact.artifactId || undefined,
    type: BLOCK_TYPES.ARTIFACT,
    artifactType: artifactTypeForArtifact(artifact),
    artifactId: artifact.artifactId || artifact.id || "",
    path: artifact.path,
    relativePath: artifact.relativePath || artifact.fileName || artifact.path,
    fileName: artifact.fileName || "",
    ext: artifact.ext || extensionFromPath(artifact.path || artifact.relativePath || artifact.fileName),
    mimeType: artifact.mimeType || "",
    bytes: artifact.bytes || 0,
    updatedAt: artifact.updatedAt || 0,
    source: artifact.source || "",
  });
}

function normalizeContentBlock(block = {}, index = 0) {
  if (block.blockType === "image" && block.data) {
    return normalizeBlock({
      id: `content:image:${index}`,
      type: BLOCK_TYPES.ARTIFACT,
      artifactType: BLOCK_TYPES.IMAGE,
      data: block.data,
      mimeType: block.mediaType || "image/png",
      alt: block.alt || "Assistant image",
      source: "content_block",
    });
  }
  return null;
}

function dedupeResultBlocks(blocks = []) {
  const seen = new Set();
  const out = [];
  for (const block of blocks) {
    if (!block?.type) continue;
    // Key on the file PATH (stable identity) rather than type/artifactType, so
    // the same file declared with a divergent type (e.g. "file" vs "html")
    // collapses to one block instead of duplicating.
    const key = block.path
      ? `path:${block.path}`
      : `${block.type}:${block.id || JSON.stringify(block).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

/**
 * Assemble the canonical result-block list for a turn.
 *
 * `extraBlocks` is first-class and validated: tools/skills that already know
 * what they produced can emit typed blocks directly here, so the UI renders
 * declared output with no path-scraping — the protocol's intended path toward
 * zero derivation.
 */
function buildResultBlocks({ artifacts = [], contentBlocks = [], extraBlocks = [] } = {}) {
  const blocks = [];
  for (const raw of extraBlocks || []) {
    const block = normalizeBlock(raw);
    if (block) blocks.push(block);
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
  BLOCK_SCHEMA_VERSION,
  BLOCK_TYPES,
  KNOWN_TYPES,
  normalizeBlock,
  buildResultBlocks,
  dedupeResultBlocks,
};
