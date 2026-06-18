// Turns the blob references produced by the message store back into loadable
// URLs. The store replaces oversized inline `data:` URLs with
// { __blobRef, mime, bytes }; here we map each back to `app-blob://<hash>?t=<mime>`,
// which the main process streams from disk on demand (no base64 in memory).

const SCHEME = "app-blob";

function blobRefToUrl(ref) {
  const mime = ref.mime ? `?t=${encodeURIComponent(ref.mime)}` : "";
  return `${SCHEME}://${ref.__blobRef}${mime}`;
}

/** Deep-map a message (or any value), replacing blob refs with app-blob:// URLs. */
export function hydrateBlobRefs(value) {
  if (Array.isArray(value)) return value.map(hydrateBlobRefs);
  if (value && typeof value === "object") {
    if (typeof value.__blobRef === "string") return blobRefToUrl(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = hydrateBlobRefs(v);
    return out;
  }
  return value;
}
