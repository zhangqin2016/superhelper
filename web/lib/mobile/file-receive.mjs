// Reassembling a file the desktop sends in chunks (file.start, file.chunk…,
// or file.error). Pure bookkeeping: bytes are collected per request and handed
// back once complete and verified; progress is reported for the page to show.

function base64ToBytes(data) {
  const binary = atob(String(data || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) return "";
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @returns {{ onFrame(frame): Promise<null | {requestId, progress?, done?, error?}> }}
 *   `done` = { name, mimeType, bytes: Uint8Array, artifactId }
 */
export function createFileReceiver({ subtle } = {}) {
  const open = new Map(); // requestId → { meta, parts: Uint8Array[], received }

  return {
    async onFrame(frame) {
      if (frame?.type === "file.start") {
        open.set(frame.requestId, { meta: frame, parts: new Array(Math.max(0, frame.count | 0)), received: 0 });
        return { requestId: frame.requestId, progress: 0, name: frame.name, bytes: frame.bytes };
      }
      if (frame?.type === "file.error") {
        open.delete(frame.requestId);
        return { requestId: frame.requestId, error: frame.code || "FILE_FAILED" };
      }
      if (frame?.type !== "file.chunk") return null;
      const entry = open.get(frame.requestId);
      if (!entry || !(frame.index >= 0 && frame.index < entry.parts.length) || entry.parts[frame.index]) return null;
      entry.parts[frame.index] = base64ToBytes(frame.data);
      entry.received += 1;
      if (entry.received < entry.parts.length) {
        return { requestId: frame.requestId, progress: entry.received / entry.parts.length, name: entry.meta.name };
      }
      open.delete(frame.requestId);
      const total = entry.parts.reduce((n, p) => n + p.length, 0);
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const part of entry.parts) { bytes.set(part, at); at += part.length; }
      if (total !== entry.meta.bytes) return { requestId: frame.requestId, error: "FILE_INCOMPLETE" };
      const digest = await sha256Hex(bytes, subtle);
      if (digest && entry.meta.sha256 && digest !== entry.meta.sha256) return { requestId: frame.requestId, error: "FILE_CORRUPTED" };
      return { requestId: frame.requestId, progress: 1, done: { name: entry.meta.name, mimeType: entry.meta.mimeType, bytes, artifactId: entry.meta.artifactId } };
    },
  };
}
