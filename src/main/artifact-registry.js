"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MANIFEST_RELATIVE_PATH = path.join(".lily-work", "artifact-manifest.json");
const GENERATED_ASSETS_DIR = "generated-assets";
const HASH_FULL_FILE_LIMIT = 32 * 1024 * 1024;
const HASH_EDGE_BYTES = 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

function isInsidePath(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function workspaceManifestPath(workspacePath = "") {
  if (!workspacePath) return "";
  return path.join(path.resolve(workspacePath), MANIFEST_RELATIVE_PATH);
}

function emptyManifest() {
  return { schemaVersion: SCHEMA_VERSION, artifacts: {}, aliases: {} };
}

function readManifest(workspacePath = "") {
  const manifestPath = workspaceManifestPath(workspacePath);
  if (!manifestPath) return emptyManifest();
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      schemaVersion: SCHEMA_VERSION,
      artifacts: parsed && typeof parsed.artifacts === "object" && parsed.artifacts ? parsed.artifacts : {},
      aliases: parsed && typeof parsed.aliases === "object" && parsed.aliases ? parsed.aliases : {},
    };
  } catch {
    return emptyManifest();
  }
}

function writeManifest(workspacePath = "", manifest = emptyManifest()) {
  const manifestPath = workspaceManifestPath(workspacePath);
  if (!manifestPath) return false;
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      artifacts: manifest.artifacts || {},
      aliases: manifest.aliases || {},
      updatedAt: new Date().toISOString(),
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

function relativeKey(workspacePath = "", filePath = "") {
  if (!workspacePath || !filePath) return "";
  const root = path.resolve(workspacePath);
  const abs = path.resolve(filePath);
  if (!isInsidePath(root, abs)) return "";
  return path.relative(root, abs).split(path.sep).join("/");
}

function absoluteFromKey(workspacePath = "", key = "") {
  if (!workspacePath || !key) return "";
  if (path.isAbsolute(key) || /^[A-Za-z]:[\\/]/.test(key)) return path.resolve(key);
  return path.resolve(workspacePath, key);
}

function mediaKindForExt(ext = "") {
  const normalized = String(ext || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(normalized)) return "image";
  if (VIDEO_EXTENSIONS.has(normalized)) return "video";
  if (AUDIO_EXTENSIONS.has(normalized)) return "audio";
  return "";
}

function statFile(filePath = "") {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fileFingerprint(filePath = "", stat = statFile(filePath)) {
  if (!stat) return "";
  const hash = crypto.createHash("sha256");
  hash.update(String(stat.size));
  hash.update(":");
  const fd = fs.openSync(filePath, "r");
  try {
    if (stat.size <= HASH_FULL_FILE_LIMIT) {
      const buffer = fs.readFileSync(fd);
      hash.update("full:");
      hash.update(buffer);
    } else {
      const head = Buffer.alloc(Math.min(HASH_EDGE_BYTES, stat.size));
      fs.readSync(fd, head, 0, head.length, 0);
      const tailSize = Math.min(HASH_EDGE_BYTES, stat.size);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, Math.max(0, stat.size - tailSize));
      hash.update("sample:");
      hash.update(hashBuffer(head));
      hash.update(":");
      hash.update(hashBuffer(tail));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function artifactIdFor(workspacePath = "", fingerprint = "") {
  return `art_${crypto.createHash("sha1").update(`${path.resolve(workspacePath)}:${fingerprint}`).digest("hex").slice(0, 20)}`;
}

function isGeneratedAssetsMedia(filePath = "") {
  const abs = path.resolve(filePath || "");
  return path.basename(path.dirname(abs)) === GENERATED_ASSETS_DIR &&
    MEDIA_EXTENSIONS.has(path.extname(abs).toLowerCase());
}

function artifactCurrentPath(workspacePath = "", artifact = {}) {
  const key = artifact.currentPath || artifact.path || "";
  const abs = absoluteFromKey(workspacePath, key);
  return abs && fs.existsSync(abs) ? abs : "";
}

function findMatchingGeneratedMedia(workspacePath = "", artifact = {}) {
  const ext = String(artifact.ext || "").toLowerCase();
  const kind = artifact.kind || mediaKindForExt(ext);
  const fingerprint = artifact.fingerprint || "";
  const bytes = Number(artifact.bytes || 0);
  if (!workspacePath || !kind || !fingerprint || !bytes) return "";
  const dir = path.join(path.resolve(workspacePath), GENERATED_ASSETS_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = path.join(dir, entry.name);
    const candidateExt = path.extname(candidate).toLowerCase();
    if (mediaKindForExt(candidateExt) !== kind) continue;
    const stat = statFile(candidate);
    if (!stat || stat.size !== bytes) continue;
    let candidateFingerprint = "";
    try {
      candidateFingerprint = fileFingerprint(candidate, stat);
    } catch {
      continue;
    }
    if (candidateFingerprint === fingerprint) return candidate;
  }
  return "";
}

function registerArtifactPath(filePath = "", metadata = {}) {
  const workspaceText = String(metadata.workspacePath || "").trim();
  const fileText = String(filePath || "").trim();
  if (!workspaceText || !fileText) return { ok: false, error: "INVALID_PATH", artifactId: "", path: "" };
  const workspacePath = path.resolve(workspaceText);
  const abs = path.resolve(fileText);
  if (!isInsidePath(workspacePath, abs)) {
    return { ok: false, error: "OUTSIDE_WORKSPACE", artifactId: "", path: abs };
  }
  const stat = statFile(abs);
  if (!stat) return { ok: false, error: "NOT_FOUND", artifactId: "", path: abs };
  const ext = path.extname(abs).toLowerCase();
  const kind = metadata.kind || mediaKindForExt(ext) || "file";
  let fingerprint = "";
  try {
    fingerprint = fileFingerprint(abs, stat);
  } catch {
    fingerprint = crypto.createHash("sha1").update(`${relativeKey(workspacePath, abs)}:${stat.size}:${stat.mtimeMs}`).digest("hex");
  }
  const artifactId = artifactIdFor(workspacePath, fingerprint);
  const key = relativeKey(workspacePath, abs);
  const manifest = readManifest(workspacePath);
  const existing = manifest.artifacts[artifactId] || {};
  const aliases = new Set([
    ...(Array.isArray(existing.aliases) ? existing.aliases : []),
    key,
    ...((metadata.aliases || []).map((item) => relativeKey(workspacePath, item)).filter(Boolean)),
  ]);
  const artifact = {
    artifactId,
    kind,
    ext,
    mimeType: metadata.mimeType || existing.mimeType || "",
    bytes: stat.size,
    fingerprint,
    currentPath: key,
    aliases: [...aliases],
    sessionId: metadata.sessionId || existing.sessionId || "",
    turnId: metadata.turnId || existing.turnId || "",
    source: metadata.source || existing.source || "",
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  manifest.artifacts[artifactId] = artifact;
  for (const alias of artifact.aliases) manifest.aliases[alias] = artifactId;
  writeManifest(workspacePath, manifest);
  return { ok: true, artifactId, path: abs, currentPath: abs, artifact };
}

function resolveArtifactReference({ workspacePath = "", artifactId = "", path: filePath = "" } = {}) {
  const workspaceText = String(workspacePath || "").trim();
  if (!workspaceText) return { ok: false, error: "INVALID_WORKSPACE", path: "" };
  const root = path.resolve(workspaceText);
  const manifest = readManifest(root);
  let id = String(artifactId || "");
  const requestedPath = filePath ? path.resolve(String(filePath)) : "";
  if (!id && requestedPath) {
    if (!isInsidePath(root, requestedPath)) return { ok: false, error: "OUTSIDE_WORKSPACE", path: requestedPath };
    const key = relativeKey(root, requestedPath);
    id = manifest.aliases[key] || "";
  }
  if (!id) {
    if (requestedPath && fs.existsSync(requestedPath)) return { ok: true, path: requestedPath, artifactId: "", recovered: false };
    return { ok: false, error: "NOT_FOUND", path: requestedPath };
  }
  const artifact = manifest.artifacts[id];
  if (!artifact) return { ok: false, error: "ARTIFACT_NOT_FOUND", path: requestedPath };
  const current = artifactCurrentPath(root, artifact);
  if (current) return { ok: true, path: current, artifactId: id, artifact, recovered: requestedPath ? current !== requestedPath : false };
  const recovered = findMatchingGeneratedMedia(root, artifact);
  if (!recovered) return { ok: false, error: "NOT_FOUND", path: requestedPath || absoluteFromKey(root, artifact.currentPath || "") };

  const key = relativeKey(root, recovered);
  artifact.currentPath = key;
  artifact.aliases = [...new Set([...(artifact.aliases || []), key])];
  artifact.updatedAt = new Date().toISOString();
  manifest.artifacts[id] = artifact;
  for (const alias of artifact.aliases) manifest.aliases[alias] = id;
  writeManifest(root, manifest);
  return { ok: true, path: recovered, artifactId: id, artifact, recovered: true };
}

function recordArtifactAlias({ workspacePath = "", fromPath = "", toPath = "" } = {}) {
  const workspaceText = String(workspacePath || "").trim();
  const targetText = String(toPath || "").trim();
  const sourceText = String(fromPath || "").trim();
  if (!workspaceText || !targetText || !sourceText) return { ok: false, error: "INVALID_PATH" };
  const root = path.resolve(workspaceText);
  const target = path.resolve(targetText);
  const source = path.resolve(sourceText);
  if (!isInsidePath(root, source) || !isInsidePath(root, target)) {
    return { ok: false, error: "OUTSIDE_WORKSPACE" };
  }
  const registered = registerArtifactPath(target, { workspacePath: root, aliases: [source] });
  return registered.ok ? { ...registered, originalPath: source } : registered;
}

module.exports = {
  registerArtifactPath,
  resolveArtifactReference,
  recordArtifactAlias,
  workspaceManifestPath,
  isGeneratedAssetsMedia,
};
