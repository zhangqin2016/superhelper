"use strict";

/**
 * `lily-preview://` — where an HTML artifact runs in the preview pane.
 *
 * The pane showed HTML in a script-free sandbox, so a generated dashboard's
 * buttons did nothing and every chart drawn by script stayed blank, although
 * the same file worked in a browser (2026-09-30). As Claude and ChatGPT do with
 * their own content domains, the page now runs with scripts on an origin of
 * its own: `lily-preview://w<workspace hash>/<path in the workspace>`. It can
 * use its scripts, its files (fetch('data.json')), localStorage — and nothing
 * of the app: the app window is file://, a different origin, so the page
 * cannot read it or reach its bridge.
 *
 * Only project workspaces are served (never userData, which holds keys and
 * settings), only files inside the workspace the host names, never a path that
 * resolves outside it, and nothing is cached, so an edited file shows on
 * reload.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fileKinds = require("../shared/file-kinds.mjs");

const SCHEME = "lily-preview";

// Web resource types the shared file-kind table does not carry; everything
// else (images, media, pdf, text) comes from the table.
const WEB_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (WEB_MIME[ext]) return WEB_MIME[ext];
  const mime = fileKinds.mimeOf(ext);
  return mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
}

function workspaceRoots() {
  // The project list the app keeps; userData is deliberately not a root here.
  try {
    const { userDataPath } = require("./config");
    const data = JSON.parse(fs.readFileSync(userDataPath("projects.json"), "utf8"));
    return (data.projects || []).map((p) => p?.path).filter(Boolean).map((p) => path.resolve(p));
  } catch {
    return [];
  }
}

function hostFor(root) {
  return `w${crypto.createHash("sha256").update(path.resolve(root).normalize("NFC")).digest("hex").slice(0, 16)}`;
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel === "" ? false : !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The preview URL for an HTML file inside a project workspace. */
function previewUrlForPath(filePath, { roots = workspaceRoots() } = {}) {
  const abs = path.resolve(String(filePath || ""));
  const root = roots
    .filter((candidate) => isInside(candidate, abs))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return { ok: false, error: "NOT_IN_WORKSPACE" };
  if (!fs.existsSync(abs)) return { ok: false, error: "NOT_FOUND" };
  const rel = path.relative(root, abs).split(path.sep).map(encodeURIComponent).join("/");
  return { ok: true, url: `${SCHEME}://${hostFor(root)}/${rel}` };
}

/** The file a preview URL names, or an HTTP status when it names none. */
function resolvePreviewRequest(requestUrl, { roots = workspaceRoots() } = {}) {
  let url;
  try { url = new URL(requestUrl); } catch { return { status: 400 }; }
  const root = roots.find((candidate) => hostFor(candidate) === url.hostname);
  if (!root) return { status: 404 };
  let rel;
  try { rel = decodeURIComponent(url.pathname.replace(/^\/+/, "")); } catch { return { status: 400 }; }
  const target = path.resolve(root, rel);
  if (!isInside(root, target)) return { status: 403 };
  let real;
  try { real = fs.realpathSync(target); } catch { return { status: 404 }; }
  // A symlink may not lead out of the workspace either.
  if (!isInside(fs.realpathSync(root), real)) return { status: 403 };
  let stat;
  try { stat = fs.statSync(real); } catch { return { status: 404 }; }
  if (!stat.isFile()) return { status: 404 };
  return { status: 200, file: real, mime: mimeFor(real) };
}

/** Must run before app `ready`. */
function registerPreviewScheme() {
  const { protocol } = require("electron");
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** Must run after app `ready`. */
function installPreviewProtocol() {
  const { protocol, net } = require("electron");
  protocol.handle(SCHEME, async (request) => {
    try {
      const resolved = resolvePreviewRequest(request.url);
      if (resolved.status !== 200) return new Response(null, { status: resolved.status });
      const res = await net.fetch(pathToFileURL(resolved.file).toString());
      return new Response(res.body, {
        status: 200,
        headers: { "Content-Type": resolved.mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch (err) {
      console.warn("[preview-protocol] request failed:", request.url, err?.message || err);
      return new Response(null, { status: 500 });
    }
  });
}

module.exports = {
  SCHEME,
  installPreviewProtocol,
  previewUrlForPath,
  registerPreviewScheme,
  resolvePreviewRequest,
};
