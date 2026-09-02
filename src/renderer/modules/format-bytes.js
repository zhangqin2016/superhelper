/** Human-readable byte size. Extracted because a third copy was about to be
 *  written for message attachments; the two prior copies disagreed, and this
 *  is the more careful of them (guards non-finite input, carries to GB). */
export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
