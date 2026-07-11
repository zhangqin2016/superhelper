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

function parseBytes(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)([kmgtp]?i?b?|b)$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2].toLowerCase();
  const power =
    unit.startsWith("k") ? 1 :
      unit.startsWith("m") ? 2 :
        unit.startsWith("g") ? 3 :
          unit.startsWith("t") ? 4 :
            unit.startsWith("p") ? 5 : 0;
  return Math.round(number * (1024 ** power));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 10 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function boundedPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
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

function inferCurlProgressLine(line = "") {
  const text = String(line || "").trim();
  if (!text || text.startsWith("% Total") || text.startsWith("Dload")) return null;
  const tokens = text.split(/\s+/);
  if (tokens.length < 10) return null;
  if (!tokens.slice(6).some((token) => /^\d+:\d{2}(?::\d{2})?$/.test(token))) return null;
  const totalPercent = boundedPercent(tokens[0]);
  const receivedPercent = boundedPercent(tokens[2]);
  const percent = receivedPercent ?? totalPercent;
  const totalBytes = parseBytes(tokens[1]);
  const writtenBytes = parseBytes(tokens[3]);
  if (percent == null && !writtenBytes) return null;
  const speedBytesPerSecond = parseBytes(tokens[tokens.length - 1]);
  return {
    source: "curl",
    domain: "download",
    phase: "downloading",
    label: "Download",
    percent,
    writtenBytes: writtenBytes || null,
    totalBytes: totalBytes || null,
    speedBytesPerSecond: speedBytesPerSecond || null,
  };
}

function inferAria2ProgressLine(line = "") {
  const text = String(line || "");
  if (!text.includes("[#") || !/\b(?:DL|UL):/i.test(text)) return null;
  const percent = boundedPercent(text.match(/\((\d+(?:\.\d+)?)%\)/)?.[1]);
  const size = text.match(/(\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B))\/(\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B))/i);
  const speed = text.match(/\b(?:DL|UL):(\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B))/i);
  const eta = text.match(/\bETA:([^\]\s]+)/i);
  if (percent == null && !size) return null;
  return {
    source: "aria2",
    domain: "download",
    phase: "downloading",
    label: "Download",
    percent,
    writtenBytes: parseBytes(size?.[1] || "") || null,
    totalBytes: parseBytes(size?.[2] || "") || null,
    speedBytesPerSecond: parseBytes(speed?.[1] || "") || null,
    eta: eta?.[1] || "",
  };
}

function inferWgetProgressLine(line = "") {
  const text = String(line || "");
  if (!/\d{1,3}%/.test(text)) return null;
  if (!/(wget|\.{5,}|\[[=>\s.]+\]|\b(?:KB|MB|GB|KiB|MiB|GiB)\/s\b|\bETA\b)/i.test(text)) return null;
  const percent = boundedPercent(text.match(/(\d{1,3}(?:\.\d+)?)%/)?.[1]);
  if (percent == null) return null;
  const speed = text.match(/(\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B))\/s/i);
  return {
    source: "wget",
    domain: "download",
    phase: "downloading",
    label: "Download",
    percent,
    speedBytesPerSecond: parseBytes(speed?.[1] || "") || null,
  };
}

function inferGenericProgressLine(line = "") {
  const text = String(line || "").trim();
  if (!text || !/%/.test(text)) return null;
  if (!/(download|upload|transfer|install|extract|verify|curl|wget|rsync|rclone|scp|mb\/s|kb\/s|mib\/s|kib\/s|eta)/i.test(text)) {
    return null;
  }
  const percent = boundedPercent(text.match(/(\d{1,3}(?:\.\d+)?)%/)?.[1]);
  if (percent == null) return null;
  return {
    source: "generic",
    domain: /upload/i.test(text) ? "upload" : "work",
    phase: /upload/i.test(text) ? "uploading" : "running",
    label: /upload/i.test(text) ? "Upload" : "Progress",
    percent,
  };
}

function inferWorkProgressLine(line = "") {
  return (
    inferAria2ProgressLine(line) ||
    inferCurlProgressLine(line) ||
    inferWgetProgressLine(line) ||
    inferGenericProgressLine(line)
  );
}

function extractStdoutRedirectTarget(command = "") {
  const text = String(command || "");
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < text.length) i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== ">") continue;

    let fdStart = i - 1;
    while (fdStart >= 0 && /\d/.test(text[fdStart])) fdStart -= 1;
    const fd = text.slice(fdStart + 1, i);
    if (fd && fd !== "1") continue;

    let targetStart = i + 1;
    if (text[targetStart] === ">") targetStart += 1;
    while (/\s/.test(text[targetStart] || "")) targetStart += 1;
    if (!text[targetStart] || text[targetStart] === "&") continue;

    const targetQuote = text[targetStart] === '"' || text[targetStart] === "'" ? text[targetStart] : "";
    if (targetQuote) {
      const end = text.indexOf(targetQuote, targetStart + 1);
      return end > targetStart ? text.slice(targetStart + 1, end).trim() : "";
    }

    let targetEnd = targetStart;
    while (targetEnd < text.length && !/[\s|;&]/.test(text[targetEnd])) targetEnd += 1;
    return text.slice(targetStart, targetEnd).trim();
  }
  return "";
}

function isDiscardOutputTarget(target = "", { platform = process.platform, command = "" } = {}) {
  const value = String(target || "").trim();
  if (value === "/dev/null") return true;
  if (!/^(?:nul:?|\$null)$/i.test(value)) return false;
  const usesWindowsTransferTool = /\b(?:curl|wget|aria2c|rsync|rclone|scp)\.exe\b/i.test(String(command || ""));
  return String(platform || process.platform).toLowerCase() === "win32" || usesWindowsTransferTool;
}

function inferWorkProgressFromCommand(command = "", options = {}) {
  const text = String(command || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const usesCurl = /\bcurl(?:\.exe)?\b/.test(lower);
  const usesTransferTool = /\b(wget|aria2c|rsync|rclone|scp)\b/.test(lower);
  if (!usesCurl && !usesTransferTool) return null;
  const url = text.match(/https?:\/\/[^\s"'`]+/i)?.[0] || "";
  const flagOutput =
    text.match(/(?:^|\s)(?:-o|--output)\s+(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/)?.slice(1).find(Boolean) ||
    "";
  const remoteName = /(?:^|\s)(?:-O|--remote-name)(?=\s|$)/.test(text);
  const rawOutput =
    flagOutput ||
    extractStdoutRedirectTarget(text);
  const output = isDiscardOutputTarget(rawOutput, {
    platform: options?.platform,
    command: text,
  }) ? "" : rawOutput;
  const upload = /\b(upload|put|scp|rsync|rclone\s+copyto?)\b/i.test(text);
  if (usesCurl && !upload && !output && !remoteName) return null;
  return {
    source: "command",
    domain: upload ? "upload" : "download",
    phase: upload ? "uploading" : "downloading",
    label: upload ? "Upload" : "Download",
    path: output || "",
    fromUrl: url || "",
  };
}

function latestWorkProgress(output = "") {
  const lines = String(output || "").split(/\r\n|\n|\r/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseWorkProgressLine(lines[index]) || inferWorkProgressLine(lines[index]);
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
  const percent = boundedPercent(progress.percent ?? progress.value);
  const writtenBytes = progress.writtenBytes ?? progress.currentBytes ?? progress.bytesDone;
  const totalBytes = progress.totalBytes ?? progress.bytesTotal;
  const speedBytesPerSecond = progress.speedBytesPerSecond ?? progress.bytesPerSecond;
  const queued = progress.queued;
  const status = String(progress.status || progress.event || "").trim();
  const location = compactPathLike(progress.path || progress.url || progress.fromUrl || "");
  const pieces = [];
  const hasOtherProgressSignal = Boolean(
    (writtenBytes && totalBytes) ||
    current != null ||
    total != null ||
    speedBytesPerSecond ||
    progress.eta ||
    queued != null ||
    status ||
    location,
  );
  if (percent != null && (percent > 0 || hasOtherProgressSignal)) pieces.push(`${Math.round(percent)}%`);
  if (writtenBytes && totalBytes) pieces.push(`${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)}`);
  if (current != null || total != null) pieces.push(`${current ?? "?"}/${total ?? "?"}`);
  if (speedBytesPerSecond) pieces.push(`${formatBytes(speedBytesPerSecond)}/s`);
  if (progress.eta) pieces.push(`ETA ${progress.eta}`);
  if (queued != null) pieces.push(`queued ${queued}`);
  if (status) pieces.push(status);
  if (location) pieces.push(location);
  return pieces.length ? `${label}: ${pieces.join(" · ")}` : label;
}

module.exports = {
  PROGRESS_MARKER,
  compactPathLike,
  formatWorkProgressDetail,
  inferWorkProgressFromCommand,
  inferWorkProgressLine,
  latestWorkProgress,
  parseWorkProgressLine,
};
