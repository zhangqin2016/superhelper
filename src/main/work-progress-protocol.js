"use strict";

const PROGRESS_MARKER = "[lily-progress]";

function compactPathLike(value = "", limit = 72) {
  let text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    text = `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    // Plain local path or label.
  }
  if (text.length <= limit) return text;
  return `...${text.slice(-(limit - 3))}`;
}

function parseProgressPayloadAfterMarker(line = "", marker = PROGRESS_MARKER) {
  const index = String(line).indexOf(marker);
  if (index < 0) return null;
  const raw = String(line).slice(index + marker.length).trim();
  if (!raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseWorkProgressLine(line = "") {
  return parseProgressPayloadAfterMarker(line, PROGRESS_MARKER);
}

function latestWorkProgress(output = "") {
  const lines = String(output || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseWorkProgressLine(lines[index]);
    if (parsed) return parsed;
  }
  return null;
}

function formatWorkProgressDetail(progress = {}) {
  const detail = String(progress.detail || progress.message || "").trim();
  if (detail) return detail;

  const label = String(progress.label || progress.title || progress.name || "work").trim();
  const current = progress.current ?? progress.done ?? progress.pageIndex ?? progress.pages;
  const total = progress.total ?? progress.max ?? progress.maxPages;
  const queued = progress.queued;
  const status = String(progress.status || progress.event || "").trim();
  const location = compactPathLike(progress.path || progress.url || progress.fromUrl || "");
  const pieces = [];
  if (current != null || total != null) pieces.push(`${current ?? "?"}/${total ?? "?"}`);
  if (queued != null) pieces.push(`queued ${queued}`);
  if (status) pieces.push(status);
  if (location) pieces.push(location);
  return pieces.length ? `${label}: ${pieces.join(" · ")}` : label;
}

module.exports = {
  PROGRESS_MARKER,
  compactPathLike,
  formatWorkProgressDetail,
  latestWorkProgress,
  parseWorkProgressLine,
};
