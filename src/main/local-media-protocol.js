"use strict";

/**
 * Serves LOCAL workspace files (generated images/videos/SVG/audio) to the renderer over
 * a privileged `app-file://` scheme. Raw `file://` is unreliable from a `file://` page
 * (Chromium blocks it cross-directory, and it's flaky on Windows), so generated media
 * never previewed. This scheme streams the bytes from disk instead.
 *
 * Security: only files UNDER a known workspace root (from projects.json) or userData are
 * served — with a path-traversal guard — so the renderer can't read arbitrary files.
 *
 * URL: app-file://media/<encodeURIComponent(absolutePath)>
 */

const { protocol, net } = require("electron");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const { userDataPath, resolveBasePath } = require("./config");
const {
  isGeneratedAssetsMedia,
  recordArtifactAlias,
  registerArtifactPath,
  resolveArtifactReference,
} = require("./artifact-registry");

const SCHEME = "app-file";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
};
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
const GENERATED_ASSETS_DIR = "generated-assets";
const GENERATED_MEDIA_RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1000;

function canonicalMediaUrl(abs) {
  return `${SCHEME}://media/${encodeURIComponent(abs)}`;
}

/** Roots the scheme is allowed to read from: every workspace + userData. Read fresh per
 *  request so projects added after launch are covered. */
function allowedRoots() {
  const roots = [];
  try { roots.push(path.resolve(resolveBasePath("userData"))); } catch { /* ignore */ }
  try {
    const data = JSON.parse(fs.readFileSync(userDataPath("projects.json"), "utf8"));
    for (const p of data.projects || []) if (p && p.path) roots.push(path.resolve(p.path));
  } catch { /* ignore */ }
  return roots;
}

function isUnder(root, abs) {
  const rel = path.relative(root, abs);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function workspaceRootForPath(abs = "", roots = allowedRoots()) {
  const normalized = path.resolve(abs);
  return roots
    .map((root) => path.resolve(root))
    .filter((root) => isUnder(root, normalized) || root === normalized)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function normalizeLocalMediaPath(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^file:/i.test(text)) {
    try {
      return require("node:url").fileURLToPath(text);
    } catch {
      return "";
    }
  }
  if (!path.isAbsolute(text)) return "";
  return path.resolve(text);
}

function mediaKindForExt(ext = "") {
  const normalized = String(ext || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(normalized)) return "image";
  if (VIDEO_EXTENSIONS.has(normalized)) return "video";
  if (AUDIO_EXTENSIONS.has(normalized)) return "audio";
  return "";
}

function generatedMediaTimestampMs(filePath = "") {
  const name = path.basename(String(filePath || ""));
  const match = name.match(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/);
  if (!match) return null;
  const iso = `${match[1]}:${match[2]}:${match[3]}${match[4] ? `.${match[4]}` : ""}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isRecoverableGeneratedMediaPath(abs = "") {
  const ext = path.extname(abs).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(ext)) return false;
  if (path.basename(path.dirname(abs)) !== GENERATED_ASSETS_DIR) return false;
  return /^(?:image|video|speech)-/i.test(path.basename(abs));
}

function resolveRecoveredGeneratedMediaPath(abs = "", roots = allowedRoots()) {
  const original = path.resolve(abs);
  if (!isRecoverableGeneratedMediaPath(original)) return "";
  const rootAllowed = roots.some((root) => isUnder(root, original) || path.resolve(root) === original);
  if (!rootAllowed) return "";
  const expectedKind = mediaKindForExt(path.extname(original).toLowerCase());
  if (!expectedKind) return "";
  const originalTime = generatedMediaTimestampMs(original);
  if (!originalTime) return "";
  const dir = path.dirname(original);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = path.join(dir, entry.name);
    if (candidate === original) continue;
    const ext = path.extname(candidate).toLowerCase();
    if (mediaKindForExt(ext) !== expectedKind) continue;
    let stat = null;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const distance = Math.abs(stat.mtimeMs - originalTime);
    if (distance > GENERATED_MEDIA_RECOVERY_WINDOW_MS) continue;
    candidates.push({ path: candidate, distance, mtimeMs: stat.mtimeMs });
  }
  if (!candidates.length) return "";
  candidates.sort((a, b) => a.distance - b.distance || b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return candidates[0].path;
}

function inspectLocalMediaPath(filePath = "") {
  const abs = normalizeLocalMediaPath(filePath);
  if (!abs) {
    return { ok: false, error: "INVALID_PATH", path: "", exists: false, authorized: false };
  }
  const roots = allowedRoots();
  const authorized = roots.some((root) => isUnder(root, abs) || path.resolve(root) === abs);
  const workspacePath = authorized ? workspaceRootForPath(abs, roots) : "";
  let resolved = abs;
  let recovered = false;
  let artifactId = "";
  let exists = fs.existsSync(resolved);
  if (!exists && authorized) {
    const artifactResolution = workspacePath
      ? resolveArtifactReference({ workspacePath, path: abs })
      : { ok: false };
    const replacement = artifactResolution.ok
      ? artifactResolution.path
      : resolveRecoveredGeneratedMediaPath(abs, roots);
    if (replacement) {
      resolved = replacement;
      recovered = true;
      artifactId = artifactResolution.artifactId || "";
      exists = fs.existsSync(resolved);
      if (!artifactId && workspacePath) {
        const alias = recordArtifactAlias({ workspacePath, fromPath: abs, toPath: resolved });
        artifactId = alias.ok ? alias.artifactId : "";
      }
    }
  }
  if (!exists) {
    return { ok: false, error: "NOT_FOUND", path: abs, exists: false, authorized, roots };
  }
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: "NOT_FOUND", path: abs, exists: false, authorized, roots };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "NOT_FILE", path: resolved, originalPath: recovered ? abs : undefined, exists: true, authorized, roots };
  }
  if (!authorized) {
    return { ok: false, error: "NOT_AUTHORIZED", path: resolved, originalPath: recovered ? abs : undefined, exists: true, authorized: false, roots };
  }
  if (!artifactId && workspacePath && isGeneratedAssetsMedia(resolved)) {
    const registered = registerArtifactPath(resolved, {
      workspacePath,
      aliases: recovered ? [abs] : [],
      kind: mediaKindForExt(path.extname(resolved).toLowerCase()) || undefined,
    });
    artifactId = registered.ok ? registered.artifactId : "";
  }
  const mime = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  return {
    ok: true,
    error: "",
    path: resolved,
    originalPath: recovered ? abs : undefined,
    artifactId,
    recovered,
    exists: true,
    authorized: true,
    byteSize: stat.size,
    mime,
    url: canonicalMediaUrl(resolved),
  };
}

function registerLocalMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function installLocalMediaProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const raw = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!raw) return new Response(null, { status: 400 });
      const status = inspectLocalMediaPath(path.resolve(raw));
      if (!status.authorized) return new Response(null, { status: 403 });
      if (!status.ok) return new Response(null, { status: status.error === "NOT_FILE" ? 400 : 404 });
      const mime = status.mime || MIME[path.extname(status.path).toLowerCase()] || "application/octet-stream";
      const res = await net.fetch(pathToFileURL(status.path).toString());
      return new Response(res.body, { status: 200, headers: { "content-type": mime, "cache-control": "max-age=3600" } });
    } catch {
      return new Response(null, { status: 500 });
    }
  });
}

module.exports = {
  registerLocalMediaScheme,
  installLocalMediaProtocol,
  inspectLocalMediaPath,
  resolveRecoveredGeneratedMediaPath,
  SCHEME,
  allowedRoots,
  canonicalMediaUrl,
  isUnder,
};
