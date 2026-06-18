"use strict";

/**
 * Moves oversized inline `data:` URLs (image thumbnails, pasted attachments)
 * out of a message envelope and into the blob store, replacing each with a
 * compact reference object:
 *
 *   "data:image/png;base64,iVBOR..."  ->  { "__blobRef": "<sha256>", "mime": "image/png", "bytes": 1234 }
 *
 * This is what shrinks the dominant payload (per analysis, user thumbnails were
 * ~16MB of a 52MB session). The renderer turns a __blobRef back into an
 * `app-blob://<hash>` URL so the bytes stream from disk on demand — never as
 * base64 held in memory.
 */

const { BlobStore } = require("./blob-store");

// Strings shorter than this stay inline — small inline icons aren't worth a
// file + a catalog row. ~8KB string ≈ ~6KB decoded.
const INLINE_THRESHOLD = 8 * 1024;

const REF_KEY = "__blobRef";

function isBlobRef(value) {
  return value && typeof value === "object" && typeof value[REF_KEY] === "string";
}

function parseDataUrl(str) {
  // data:[<mime>][;base64],<payload>
  const comma = str.indexOf(",");
  if (comma < 0) return null;
  const header = str.slice(5, comma); // after "data:"
  if (!/;base64$/i.test(header) && !/;base64;/i.test(header)) {
    // only base64 payloads are externalized (text data URLs are tiny / rare)
    if (!header.toLowerCase().includes(";base64")) return null;
  }
  const mime = header.split(";")[0] || "application/octet-stream";
  const buffer = Buffer.from(str.slice(comma + 1), "base64");
  return { mime, buffer };
}

function shouldExternalize(str) {
  return (
    typeof str === "string" &&
    str.length >= INLINE_THRESHOLD &&
    str.startsWith("data:") &&
    str.toLowerCase().includes(";base64,")
  );
}

/**
 * @param {object} message            the full message envelope to persist
 * @param {BlobStore} blobStore
 * @returns {{ envelope: object, refs: Array<{hash,bytes,mime}> }}
 */
function externalize(message, blobStore) {
  const refs = [];
  const seen = new Map(); // hash -> ref (dedupe within one message)

  const externalizeBuffer = (buffer, mime) => {
    const { hash, bytes } = blobStore.write(buffer);
    if (!seen.has(hash)) {
      seen.set(hash, true);
      refs.push({ hash, bytes, mime });
    }
    return { [REF_KEY]: hash, mime, bytes };
  };

  const walk = (value) => {
    if (typeof value === "string") {
      if (!shouldExternalize(value)) return value;
      const parsed = parseDataUrl(value);
      if (!parsed) return value;
      return externalizeBuffer(parsed.buffer, parsed.mime);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (isBlobRef(value)) return value; // already externalized — pass through
    if (value && typeof value === "object") {
      // Content-image shape: a raw base64 `data` field paired with an image
      // mime. Externalize the bytes (same blob pipeline as data: URLs) so
      // assistant-generated images never live as base64 in the record/memory.
      const mime = value.mediaType || value.mimeType;
      const isImageData =
        typeof value.data === "string" &&
        value.data.length >= INLINE_THRESHOLD &&
        typeof mime === "string" &&
        /^image\//i.test(mime) &&
        !value.data.startsWith("data:");
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (isImageData && k === "data") {
          out[k] = externalizeBuffer(Buffer.from(v, "base64"), mime);
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return value;
  };

  return { envelope: walk(message), refs };
}

/** Collect the blob hashes referenced anywhere in an envelope (for GC). */
function collectRefs(value, acc = new Set()) {
  if (isBlobRef(value)) {
    acc.add(value[REF_KEY]);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectRefs(v, acc);
  }
  return acc;
}

module.exports = { externalize, collectRefs, isBlobRef, REF_KEY, INLINE_THRESHOLD };
