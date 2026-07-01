"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LARGE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_SAMPLE_LINES = 40;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 80;
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
  ".xml", ".html", ".htm", ".log", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".go", ".rs", ".rb", ".php", ".css", ".scss", ".sql", ".sh",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);

function okBase(filePath, stat) {
  return {
    ok: true,
    sourcePath: filePath,
    byteSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function fail(error, detail = {}, filePath = "") {
  return {
    ok: false,
    error,
    sourcePath: filePath || detail.sourcePath || "",
    coverage: "failed",
    confidence: "exact",
    ...detail,
  };
}

function statPath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved) return { error: fail("PATH_REQUIRED") };
  try {
    return { path: resolved, stat: fs.statSync(resolved) };
  } catch (err) {
    return { path: resolved, error: fail("PATH_UNAVAILABLE", { message: err?.message || String(err) }, resolved) };
  }
}

function extensionKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext === ".pdf") return "pdf";
  if ([".xlsx", ".xlsm", ".xls"].includes(ext)) return "spreadsheet";
  if ([".docx", ".doc"].includes(ext)) return "document";
  if ([".pptx", ".ppt"].includes(ext)) return "presentation";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "binary";
}

function looksBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;
  let nul = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) nul += 1;
  }
  return nul > 0;
}

function readTextPrefix(filePath, maxBytes = DEFAULT_MAX_TEXT_BYTES) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const bytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    if (looksBinary(buffer)) return { binary: true, text: "" };
    return { binary: false, text: buffer.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function countLinesFromPrefix(prefix, statSize, maxBytes = DEFAULT_MAX_TEXT_BYTES) {
  const lines = prefix ? splitTextLines(prefix).length : 0;
  if (statSize <= maxBytes) return { lineCount: lines, estimated: false };
  const avg = prefix.length ? prefix.length / Math.max(1, lines) : 80;
  return { lineCount: Math.ceil(statSize / Math.max(1, avg)), estimated: true };
}

function splitTextLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readHeader(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function inspectImageMetadata(filePath) {
  const header = readHeader(filePath, 4096);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    header.length >= 24
    && header.subarray(0, pngSignature.length).equals(pngSignature)
    && header.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return {
      format: "png",
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
    };
  }
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < header.length) {
      if (header[offset] !== 0xff) break;
      const marker = header[offset + 1];
      const len = header.readUInt16BE(offset + 2);
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < header.length) {
        return {
          format: "jpeg",
          width: header.readUInt16BE(offset + 7),
          height: header.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + len;
    }
    return { format: "jpeg" };
  }
  return undefined;
}

function recommendedActionsFor(kind, large) {
  if (kind === "text") {
    return large ? ["sample", "extract-range", "index"] : ["extract", "sample", "index"];
  }
  if (kind === "directory") return ["sample", "index"];
  if (kind === "pdf") return ["sample-metadata", "index-document", "query-document-index"];
  if (kind === "spreadsheet") return ["sample-metadata", "index-sheets", "query-document-index"];
  if (kind === "document") return ["sample-metadata", "index-document", "query-document-index"];
  if (kind === "presentation") return ["sample-metadata", "index-document", "verify-render"];
  if (kind === "image") return ["sample-metadata", "ocr-if-needed", "image-analyze"];
  if (kind === "video" || kind === "audio") return ["sample-metadata", "probe-media"];
  return ["sample-metadata"];
}

function dependencyRouteFor(kind) {
  if (kind === "pdf") {
    return {
      indexPolicy: "page-index",
      requiredPacks: ["large-document", "pro-pdf", "rapidocr"],
    };
  }
  if (kind === "spreadsheet") {
    return {
      indexPolicy: "sheet-index",
      requiredPacks: ["large-document", "libreoffice"],
    };
  }
  if (kind === "document") {
    return {
      indexPolicy: "paragraph-index",
      requiredPacks: ["large-document", "libreoffice"],
    };
  }
  if (kind === "presentation") {
    return {
      indexPolicy: "slide-index",
      requiredPacks: ["libreoffice"],
    };
  }
  if (kind === "image") {
    return {
      indexPolicy: "metadata-only",
      requiredPacks: ["pillow", "opencv", "rapidocr", "rembg"],
    };
  }
  if (kind === "video" || kind === "audio") {
    return {
      indexPolicy: "media-probe",
      requiredPacks: ["ffmpeg"],
    };
  }
  return {};
}

function inspectDirectory(filePath, stat, options = {}) {
  const maxEntries = Number(options.maxDirectoryEntries || DEFAULT_MAX_DIRECTORY_ENTRIES);
  const names = fs.readdirSync(filePath);
  const entries = [];
  for (const name of names.slice(0, maxEntries)) {
    const child = path.join(filePath, name);
    try {
      const st = fs.statSync(child);
      entries.push({
        name,
        kind: st.isDirectory() ? "directory" : extensionKind(child),
        byteSize: st.size,
      });
    } catch {
      entries.push({ name, kind: "unknown" });
    }
  }
  return {
    ...okBase(filePath, stat),
    kind: "directory",
    sourceType: "directory",
    coverage: names.length > maxEntries ? "sampled" : "full",
    confidence: "exact",
    entryCount: names.length,
    entries,
    truncated: names.length > maxEntries,
    recommendedActions: recommendedActionsFor("directory", false),
  };
}

function inspectPath(input = {}, options = {}) {
  const current = statPath(input.path);
  if (current.error) return current.error;
  const filePath = current.path;
  const stat = current.stat;
  if (stat.isDirectory()) return inspectDirectory(filePath, stat, options);
  if (!stat.isFile()) return fail("UNSUPPORTED_PATH", { kind: "unknown" }, filePath);

  const largeThreshold = Number(options.largeThresholdBytes || DEFAULT_LARGE_THRESHOLD_BYTES);
  const extKind = extensionKind(filePath);
  let kind = extKind;
  let lineInfo = {};
  if (extKind === "text") {
    const prefix = readTextPrefix(filePath);
    if (prefix.binary) {
      kind = "binary";
    } else {
      lineInfo = countLinesFromPrefix(prefix.text, stat.size);
    }
  } else if (extKind === "binary") {
    const prefix = readTextPrefix(filePath, Math.min(8192, stat.size));
    if (!prefix.binary && prefix.text.trim()) {
      kind = "text";
      lineInfo = countLinesFromPrefix(prefix.text, stat.size, 8192);
    }
  }

  const large = stat.size > largeThreshold;
  const typeSpecificInfo = kind === "image" ? { image: inspectImageMetadata(filePath) } : {};
  const dependencyRoute = dependencyRouteFor(kind);
  return {
    ...okBase(filePath, stat),
    kind,
    sourceType: kind,
    extension: path.extname(filePath).toLowerCase(),
    large,
    coverage: "metadata",
    confidence: "exact",
    ...typeSpecificInfo,
    ...dependencyRoute,
    ...lineInfo,
    recommendedActions: recommendedActionsFor(kind, large),
  };
}

function readAllText(filePath, maxBytes = DEFAULT_MAX_TEXT_BYTES * 4) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    const prefix = readTextPrefix(filePath, maxBytes);
    return prefix.text;
  }
  const buffer = fs.readFileSync(filePath);
  if (looksBinary(buffer)) return null;
  return buffer.toString("utf8");
}

function lineSlice(lines, start, end) {
  const s = Math.max(1, Number(start || 1));
  const e = Math.max(s, Math.min(lines.length, Number(end || s)));
  return {
    text: lines.slice(s - 1, e).join("\n"),
    start: s,
    end: e,
    totalLines: lines.length,
  };
}

function extractLineRange(filePath, start, end) {
  const s = Math.max(1, Number(start || 1));
  const e = Math.max(s, Number(end || s));
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let leftover = "";
    let lineNo = 1;
    const out = [];
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const chunk = leftover + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const line of lines) {
        if (lineNo >= s && lineNo <= e) out.push(line);
        lineNo += 1;
        if (lineNo > e) return { text: out.join("\n"), start: s, end: Math.min(e, lineNo - 1), totalLinesSeen: lineNo - 1 };
      }
    } while (bytesRead > 0);
    if (leftover || lineNo === 1) {
      if (lineNo >= s && lineNo <= e) out.push(leftover);
      lineNo += 1;
    }
    return { text: out.join("\n"), start: s, end: Math.min(e, lineNo - 1), totalLinesSeen: lineNo - 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function samplePath(input = {}, options = {}) {
  const info = inspectPath(input, options);
  if (!info.ok) return info;
  if (info.kind === "directory") return info;
  if (info.kind === "binary" || !["text"].includes(info.kind)) {
    return fail("UNSUPPORTED_BINARY", { kind: info.kind, byteSize: info.byteSize }, info.sourcePath);
  }
  const text = readAllText(info.sourcePath);
  if (text == null) return fail("UNSUPPORTED_BINARY", { kind: "binary" }, info.sourcePath);
  const lines = splitTextLines(text);
  const requested = Math.max(1, Math.min(Number(input.lines || options.lines || DEFAULT_MAX_SAMPLE_LINES), 500));
  const strategy = String(input.strategy || "head").toLowerCase();
  let start = 1;
  if (strategy === "tail") start = Math.max(1, lines.length - requested + 1);
  else if (strategy === "middle") start = Math.max(1, Math.floor((lines.length - requested) / 2) + 1);
  const end = Math.min(lines.length, start + requested - 1);
  return {
    ok: true,
    sourcePath: info.sourcePath,
    sourceType: info.kind,
    coverage: "sampled",
    confidence: "exact",
    rangeType: "lines",
    rangeStart: start,
    rangeEnd: end,
    totalLines: lines.length,
    text: lines.slice(start - 1, end).join("\n"),
    warning: "Sampled evidence is not full-file coverage.",
  };
}

function extractPath(input = {}, options = {}) {
  const info = inspectPath(input, options);
  if (!info.ok) return info;
  if (info.kind === "directory") return fail("RANGE_REQUIRED", { kind: "directory" }, info.sourcePath);
  if (info.kind === "binary" || !["text"].includes(info.kind)) {
    return fail("UNSUPPORTED_BINARY", { kind: info.kind, byteSize: info.byteSize }, info.sourcePath);
  }
  const range = input.range || {};
  const rangeType = String(range.type || "");
  const largeThreshold = Number(options.largeThresholdBytes || DEFAULT_LARGE_THRESHOLD_BYTES);
  if (info.byteSize > largeThreshold && rangeType !== "lines") {
    return fail("RANGE_REQUIRED", {
      kind: info.kind,
      byteSize: info.byteSize,
      message: "Large inputs require an explicit range.",
    }, info.sourcePath);
  }
  const text = readAllText(info.sourcePath);
  if (text == null) return fail("UNSUPPORTED_BINARY", { kind: "binary" }, info.sourcePath);
  if (rangeType === "lines") {
    const sliced = info.byteSize > DEFAULT_MAX_TEXT_BYTES
      ? extractLineRange(info.sourcePath, range.start, range.end)
      : lineSlice(splitTextLines(text), range.start, range.end);
    return {
      ok: true,
      sourcePath: info.sourcePath,
      sourceType: info.kind,
      coverage: "partial",
      confidence: "exact",
      rangeType: "lines",
      rangeStart: sliced.start,
      rangeEnd: sliced.end,
      totalLines: sliced.totalLines || undefined,
      totalLinesSeen: sliced.totalLinesSeen || undefined,
      text: sliced.text,
    };
  }
  return {
    ok: true,
    sourcePath: info.sourcePath,
    sourceType: info.kind,
    coverage: "full",
    confidence: "exact",
    rangeType: "file",
    rangeStart: 1,
    rangeEnd: 1,
    text,
  };
}

module.exports = {
  DEFAULT_LARGE_THRESHOLD_BYTES,
  extractPath,
  inspectPath,
  samplePath,
};
