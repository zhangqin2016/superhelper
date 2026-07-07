export function fileUrlFromPath(filePath = "") {
  const value = String(filePath || "");
  if (/^(https?:|app-file:|app-blob:|blob:|data:)/i.test(value)) return value;
  // Serve local files via the privileged app-file:// scheme. Raw file:// is
  // blocked or flaky from a file:// page, so local image previews can fail.
  if (/^file:/i.test(value)) {
    try {
      const decoded = decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:[\\/])/, "$1");
      return `app-file://media/${encodeURIComponent(decoded)}`;
    } catch {
      return value;
    }
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return `app-file://media/${encodeURIComponent(value)}`;
  }
  return value;
}

export function dataUrl(block = {}) {
  if (!block.data) return "";
  const data = String(block.data);
  if (/^(app-blob:|data:|https?:|file:|blob:)/i.test(data)) return data;
  return `data:${block.mimeType || "image/png"};base64,${data}`;
}

export function artifactSourceUrl(block = {}) {
  return dataUrl(block) || fileUrlFromPath(block.path || "");
}

export function bytesText(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactDisplayName(block = {}, fallback = "Artifact") {
  return block.title || block.relativePath || block.fileName || block.path || block.alt || fallback;
}
