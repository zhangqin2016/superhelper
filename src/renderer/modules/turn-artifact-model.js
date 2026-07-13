import {
  generatedMediaFromPayload,
  parseToolResult,
} from "./tool-payload-renderer.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export function stripGeneratedMediaMarkers(text = "") {
  return String(text || "")
    .replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (block) => block.replace(/</g, "\u0000"))
    .replace(/<generated_media\b[^>]*>[\s\S]*?<\/generated_media>/g, "")
    .replace(/\u0000/g, "<")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeGeneratedMediaMarkers(text = "") {
  return String(text || "").replace(/<(\/?generated_media\b[^>]*|file\b[^>]*\/?)>/g, (_match, tag) => (
    `&lt;${tag}&gt;`
  ));
}

export function collectHoistableMedia(liveTurn) {
  const seen = new Set();
  const blocks = [];
  const tools = liveTurn?.tools instanceof Map
    ? [...liveTurn.tools.values()]
    : (Array.isArray(liveTurn?.tools) ? liveTurn.tools : []);
  for (const tool of tools) {
    let payload = null;
    try { payload = parseToolResult(tool?.result); } catch { payload = null; }
    if (!payload) continue;
    let media = [];
    try { media = generatedMediaFromPayload(payload) || []; } catch { media = []; }
    for (const block of media) {
      const key = (block.files || []).map((file) => file.path).join("|") || JSON.stringify(block);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(block);
    }
  }
  return blocks;
}

export function groupHoistableMediaBlocks(blocks = []) {
  const files = [];
  const seen = new Set();
  for (const block of blocks || []) {
    const type = block?.type || "file";
    for (const file of block.files || []) {
      if (!file?.path || seen.has(file.path)) continue;
      seen.add(file.path);
      files.push({ ...file, type });
    }
  }
  return files.length ? [{ type: "file", taskId: "", files }] : [];
}

function normalizeExtension(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith(".") ? text : `.${text}`;
}

function extensionFromPath(filePath = "") {
  const match = String(filePath || "").match(/\.[^./\\]+$/);
  return normalizeExtension(match?.[0] || "");
}

export function inferArtifactType(block = {}) {
  const declared = String(block.artifactType || block.type || "").toLowerCase();
  if (["image", "pdf", "html", "markdown", "chart", "video", "audio"].includes(declared)) return declared;
  const mime = String(block.mimeType || "").toLowerCase();
  const ext = normalizeExtension(block.ext || extensionFromPath(block.path || block.relativePath || block.fileName));
  if (block.kind === "image" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (block.kind === "video" || mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return "video";
  if (block.kind === "audio" || mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime === "text/markdown" || MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (mime === "text/html" || ext === ".html" || ext === ".htm") return "html";
  return "file";
}

function hashStr(value = "") {
  const s = String(value || "");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function blockTextOf(block = {}) {
  return block.text || block.source || block.code || block.diff || "";
}

export function turnResultBlockKey(block = {}) {
  const text = blockTextOf(block);
  return [
    block.id || "",
    block.type || "",
    block.artifactType || "",
    block.path || "",
    block.updatedAt || "",
    block.bytes || "",
    `${text.length}:${hashStr(text)}`,
  ].join(":");
}

export function artifactBlocksFromArtifacts(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => artifact?.path)
    .map((artifact) => ({
      id: `artifact:${artifact.id || artifact.path}`,
      type: "artifact",
      artifactType: inferArtifactType(artifact),
      path: artifact.path,
      relativePath: artifact.relativePath || artifact.fileName || artifact.path,
      fileName: artifact.fileName || "",
      ext: artifact.ext || extensionFromPath(artifact.path || artifact.relativePath || artifact.fileName),
      mimeType: artifact.mimeType || "",
      bytes: artifact.bytes || 0,
      updatedAt: artifact.updatedAt || 0,
      source: artifact.source || "",
    }));
}

function fillMissingBlockFields(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    const currentEmpty = current === undefined || current === null || current === "" || current === 0;
    const valueOk = value !== undefined && value !== null && value !== "" && value !== 0;
    if (currentEmpty && valueOk) out[key] = value;
  }
  return out;
}

export function mergeTurnResultBlocks(resultBlocks = [], artifacts = []) {
  const byKey = new Map();
  const order = [];
  for (const block of [...(resultBlocks || []), ...artifactBlocksFromArtifacts(artifacts)]) {
    if (!block?.type) continue;
    const key = block.path
      ? `path:${block.path}`
      : `${block.type}:${block.artifactType || ""}:${block.id || block.data || turnResultBlockKey(block)}`;
    const previous = byKey.get(key);
    if (previous) {
      byKey.set(key, fillMissingBlockFields(previous, block));
    } else {
      byKey.set(key, block);
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key));
}

export function isImageResultBlock(block = {}) {
  return inferArtifactType(block) === "image";
}

export function shouldHideImageResultBlock(block = {}, { hasInlineImages = false } = {}) {
  if (block.source === "content_block") return true;
  return Boolean(hasInlineImages && isImageResultBlock(block));
}
