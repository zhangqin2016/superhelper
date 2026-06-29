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

const SCHEME = "app-file";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
};

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

function inspectLocalMediaPath(filePath = "") {
  const abs = normalizeLocalMediaPath(filePath);
  if (!abs) {
    return { ok: false, error: "INVALID_PATH", path: "", exists: false, authorized: false };
  }
  const exists = fs.existsSync(abs);
  const roots = allowedRoots();
  const authorized = roots.some((root) => isUnder(root, abs) || path.resolve(root) === abs);
  if (!exists) {
    return { ok: false, error: "NOT_FOUND", path: abs, exists: false, authorized, roots };
  }
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, error: "NOT_FOUND", path: abs, exists: false, authorized, roots };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "NOT_FILE", path: abs, exists: true, authorized, roots };
  }
  if (!authorized) {
    return { ok: false, error: "NOT_AUTHORIZED", path: abs, exists: true, authorized: false, roots };
  }
  const mime = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  return {
    ok: true,
    error: "",
    path: abs,
    exists: true,
    authorized: true,
    byteSize: stat.size,
    mime,
    url: canonicalMediaUrl(abs),
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
      const abs = path.resolve(raw);
      const roots = allowedRoots();
      if (!roots.some((root) => isUnder(root, abs))) return new Response(null, { status: 403 });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response(null, { status: 404 });
      const mime = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
      const res = await net.fetch(pathToFileURL(abs).toString());
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
  SCHEME,
  allowedRoots,
  canonicalMediaUrl,
  isUnder,
};
