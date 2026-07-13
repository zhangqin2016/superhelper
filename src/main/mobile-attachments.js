"use strict";

// Materialize phone-sent attachments (base64 in the relay frame) into local
// temp files, so a mobile command's images/files reach the turn as real paths
// (the agent reads files from disk). Pure decode + a thin injected writer, so
// the decode/validate rules are unit-tested without fs.
//
// Bounded on purpose: the relay frame is capped at 256KB, so attachments are
// small (the phone downscales images first). We still cap count + per-file size
// here as defense in depth. Fail-open: a bad/oversized attachment is skipped,
// never throwing — the command still runs (text-only worst case).

const MAX_FILES = 6;
const MAX_BYTES = 512 * 1024; // per file, after base64 decode

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

function safeBaseName(name, ext) {
  // Strip path/unsafe chars + leading dots/underscores, drop any existing
  // extension, then append the canonical one. Prevents path traversal and
  // guarantees a known-safe extension.
  let base = String(name || "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 60)
    .replace(/\.[^.]*$/, "");
  if (!base) base = "attachment";
  return `${base}.${ext}`;
}

/**
 * Pure: validate + decode one attachment {name, mimeType, dataBase64} → a
 * { buffer, name } ready to write, or null if invalid/oversized/unsupported.
 */
function decodeAttachment(att) {
  if (!att || typeof att !== "object") return null;
  const mimeType = String(att.mimeType || att.type || "").toLowerCase();
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) return null; // only known-safe types
  const b64 = String(att.dataBase64 || att.data || "").replace(/^data:[^,]*,/, "");
  if (!b64) return null;
  let buffer;
  try { buffer = Buffer.from(b64, "base64"); } catch { return null; }
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  return { buffer, name: safeBaseName(att.name, ext), ext };
}

/**
 * Materialize up to MAX_FILES attachments to temp files. `deps`:
 *  - tmpDir: directory to write into
 *  - mkdirSync(dir), writeFileSync(path, buffer), join(dir, name) (defaults: node)
 *  - stamp: string to make filenames unique (default: caller supplies; tests pass fixed)
 * Returns [{ path, name }]. Fail-open per file.
 */
function materializeMobileAttachments(attachments, deps = {}) {
  const list = (Array.isArray(attachments) ? attachments : []).slice(0, MAX_FILES);
  if (!list.length) return [];
  const path = deps.path || require("node:path");
  const fs = deps.fs || require("node:fs");
  const tmpDir = deps.tmpDir;
  if (!tmpDir) return [];
  const stamp = String(deps.stamp || "");
  try { (deps.mkdirSync || ((d) => fs.mkdirSync(d, { recursive: true })))(tmpDir); } catch { /* may exist */ }
  const out = [];
  list.forEach((att, i) => {
    const decoded = decodeAttachment(att);
    if (!decoded) return;
    const fileName = `mcmd_${stamp}_${i}_${decoded.name}`;
    const dest = (deps.join || path.join)(tmpDir, fileName);
    try {
      (deps.writeFileSync || fs.writeFileSync)(dest, decoded.buffer);
      out.push({ path: dest, name: decoded.name });
    } catch { /* skip this one, fail-open */ }
  });
  return out;
}

module.exports = { MAX_FILES, MAX_BYTES, decodeAttachment, materializeMobileAttachments, safeBaseName };
