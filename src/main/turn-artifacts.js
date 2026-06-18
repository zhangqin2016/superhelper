"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const FILE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".html",
  ".htm",
]);

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
};

// Linear (no nested quantifier): a path-ish prefix, then a single run of
// non-delimiter chars (which may include slashes), then a known extension.
// The previous `(?:…+[\\/])*…+?` form had catastrophic backtracking that made
// scanning large records take seconds per record.
const PATH_LIKE_RE =
  /((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[\w@.-]+[\\/])[^\s"'`<>|]*?\.(?:png|jpe?g|webp|gif|svg|pdf|docx?|xlsx?|pptx?|csv|html?))/gi;

// Bounds so artifact derivation stays cheap even over large/many records:
// a single huge tool result (e.g. a file dump) is only scanned up to a cap, and
// the total candidate set is capped. This keeps the regex (which can backtrack
// on pathological input) and the follow-up statSync count predictable.
const MAX_STRING_SCAN = 64 * 1024;
const MAX_CANDIDATES = 64;

function stableArtifactId(filePath) {
  return `artifact_${crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16)}`;
}

function normalizePathCandidate(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/[),，。；;:：]+$/g, "");
  if (text.startsWith("file://")) {
    try {
      return fileURLToPath(text);
    } catch {
      return "";
    }
  }
  return text;
}

function isInsidePath(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCandidatePath(candidate, workspacePath) {
  const normalized = normalizePathCandidate(candidate);
  if (!normalized) return "";
  if (/^[A-Za-z]:[\\/]/.test(normalized) || path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  if (!workspacePath) return "";
  return path.resolve(workspacePath, normalized);
}

function artifactKindForPath(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (FILE_EXTENSIONS.has(ext)) return "file";
  return "";
}

function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function toArtifact(filePath, source, workspacePath) {
  const kind = artifactKindForPath(filePath);
  if (!kind) return null;
  const stat = statFile(filePath);
  if (!stat) return null;
  const absolutePath = path.resolve(filePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const relativePath = workspacePath && isInsidePath(workspacePath, absolutePath)
    ? path.relative(workspacePath, absolutePath)
    : "";
  return {
    id: stableArtifactId(absolutePath),
    kind,
    path: absolutePath,
    relativePath: relativePath || absolutePath,
    fileName: path.basename(absolutePath),
    ext,
    mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
    bytes: stat.size,
    updatedAt: stat.mtimeMs,
    source,
  };
}

function addArtifact(map, artifact) {
  if (!artifact?.path) return;
  const key = path.resolve(artifact.path);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, artifact);
    return;
  }
  const sources = new Set([
    ...String(existing.source || "").split(",").filter(Boolean),
    ...String(artifact.source || "").split(",").filter(Boolean),
  ]);
  existing.source = [...sources].join(",");
}

function collectPathStrings(value, out, depth = 0) {
  if (depth > 8 || value == null || out.size >= MAX_CANDIDATES) return;
  if (typeof value === "string") {
    // Only scan the head of very large strings — a path reference near the end
    // of a multi-MB file dump isn't worth scanning the whole blob (and bounds
    // regex backtracking cost).
    const text = value.length > MAX_STRING_SCAN ? value.slice(0, MAX_STRING_SCAN) : value;
    for (const match of text.matchAll(PATH_LIKE_RE)) {
      out.add(match[1]);
      if (out.size >= MAX_CANDIDATES) return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.size >= MAX_CANDIDATES) return;
      collectPathStrings(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      if (out.size >= MAX_CANDIDATES) return;
      collectPathStrings(item, out, depth + 1);
    }
  }
}

function addCandidate(map, candidate, source, workspacePath, { requireWorkspace = false } = {}) {
  const resolved = resolveCandidatePath(candidate, workspacePath);
  if (!resolved) return;
  if (requireWorkspace && workspacePath && !isInsidePath(workspacePath, resolved)) return;
  // Skip the statSync entirely if this path was already resolved this build —
  // just merge the source on the existing artifact.
  const key = path.resolve(resolved);
  if (map.has(key)) {
    addArtifact(map, { path: key, source });
    return;
  }
  addArtifact(map, toArtifact(resolved, source, workspacePath));
}

function buildTurnArtifacts({ assistantText = "", fileChanges = [], tools = [], workspacePath = "" } = {}) {
  const artifacts = new Map();
  const root = workspacePath ? path.resolve(workspacePath) : "";

  for (const change of fileChanges || []) {
    addCandidate(artifacts, change?.filePath, "file_change", root);
  }

  for (const tool of tools || []) {
    const candidates = new Set();
    collectPathStrings(tool?.result, candidates);
    if (toolInputMayCreateArtifacts(tool?.name)) {
      collectPathStrings(tool?.input, candidates);
    }
    for (const candidate of candidates) {
      addCandidate(artifacts, candidate, "tool", root);
    }
  }

  const textCandidates = new Set();
  collectPathStrings(assistantText, textCandidates);
  for (const candidate of textCandidates) {
    addCandidate(artifacts, candidate, "assistant_text", root, { requireWorkspace: true });
  }

  return [...artifacts.values()].sort((a, b) => {
    const aImage = a.kind === "image" ? 0 : 1;
    const bImage = b.kind === "image" ? 0 : 1;
    if (aImage !== bImage) return aImage - bImage;
    return String(a.relativePath || a.path).localeCompare(String(b.relativePath || b.path));
  });
}

function toolInputMayCreateArtifacts(toolName = "") {
  const name = String(toolName || "").toLowerCase();
  return (
    name === "bash" ||
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("generate") ||
    name.includes("render") ||
    name.includes("export")
  );
}

module.exports = {
  buildTurnArtifacts,
  isInsidePath,
  resolveCandidatePath,
};
