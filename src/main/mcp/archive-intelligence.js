"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SUSPICIOUS_EXPANSION_RATIO = 200;
const ARCHIVE_SUFFIXES = [
  ".tar.gz", ".tar.bz2", ".tar.xz",
  ".zip", ".7z", ".rar", ".tar", ".tgz", ".tbz", ".tbz2", ".txz",
  ".gz", ".bz2", ".xz", ".jar", ".war", ".ear", ".apk", ".ipa", ".epub",
  ".cbz", ".xpi", ".cab", ".iso", ".deb", ".rpm",
];
const SEMANTIC_ZIP_CONTAINER_EXTENSIONS = new Set([
  ".docx", ".xlsx", ".xlsm", ".pptx", ".odt", ".ods", ".odp",
]);

function fail(error, detail = {}, sourcePath = "") {
  return {
    ok: false,
    error,
    sourcePath: sourcePath || detail.sourcePath || "",
    coverage: "failed",
    confidence: "exact",
    ...detail,
  };
}

function archiveKindForPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ? "archive" : "";
}

function detectArchiveFormat(filePath) {
  const byExtension = archiveKindForPath(filePath);
  if (byExtension) {
    const lower = String(filePath || "").toLowerCase();
    const suffix = ARCHIVE_SUFFIXES.find((item) => lower.endsWith(item)) || "";
    return suffix.replace(/^\./, "") || "archive";
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "";
    const fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(Math.min(stat.size, 512));
      fs.readSync(fd, header, 0, header.length, 0);
      if (header.length >= 4 && header.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))) return "zip";
      if (header.length >= 6 && header.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7z";
      if (header.length >= 7 && header.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))) return "rar";
      if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))) return "rar5";
      if (header.length >= 2 && header.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) return "gzip";
      if (header.length >= 3 && header.subarray(0, 3).toString("ascii") === "BZh") return "bzip2";
      if (header.length >= 6 && header.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return "xz";
      if (header.length >= 262 && header.subarray(257, 262).toString("ascii") === "ustar") return "tar";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  return "";
}

function isSemanticZipContainerPath(filePath) {
  return SEMANTIC_ZIP_CONTAINER_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function isArchiveFilePath(filePath) {
  return !isSemanticZipContainerPath(filePath) && Boolean(detectArchiveFormat(filePath));
}

function unsafeArchiveEntryPath(entryPath) {
  const value = String(entryPath || "").replace(/\\/g, "/");
  if (!value) return true;
  if (/[\u0000-\u001f\u007f]/.test(value)) return true;
  if (value.startsWith("-") || value.startsWith("@")) return true;
  if (value.startsWith("/") || value.startsWith("//") || /^[a-z]:\//i.test(value)) return true;
  return value.split("/").some((segment) => segment === "..");
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseSevenZipList(output, options = {}) {
  const maxEntries = Math.max(1, Math.min(Number(options.maxEntries || DEFAULT_MAX_ENTRIES), 5000));
  const blocks = String(output || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  const allEntries = [];
  for (const block of blocks) {
    const fields = {};
    for (const line of block.split("\n")) {
      const separator = line.indexOf(" = ");
      if (separator <= 0) continue;
      fields[line.slice(0, separator).trim()] = line.slice(separator + 3).trim();
    }
    if (!fields.Path) continue;
    const entryPath = fields.Path.replace(/\\/g, "/");
    const folder = fields.Folder === "+" || String(fields.Attributes || "").startsWith("D");
    const entry = {
      path: entryPath,
      kind: folder ? "directory" : "file",
      size: parseInteger(fields.Size),
      packedSize: parseInteger(fields["Packed Size"]),
      encrypted: fields.Encrypted === "+",
      unsafePath: unsafeArchiveEntryPath(entryPath),
    };
    if (fields.Modified) entry.modifiedAt = fields.Modified;
    allEntries.push(entry);
  }
  const entries = allEntries.slice(0, maxEntries);
  const files = allEntries.filter((entry) => entry.kind === "file");
  const totalUncompressedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const totalPackedBytes = files.reduce((sum, entry) => sum + entry.packedSize, 0);
  const expansionRatio = totalPackedBytes > 0 ? totalUncompressedBytes / totalPackedBytes : 0;
  return {
    entries,
    entryCount: allEntries.length,
    fileCount: files.length,
    directoryCount: allEntries.length - files.length,
    encryptedEntryCount: allEntries.filter((entry) => entry.encrypted).length,
    unsafeEntryCount: allEntries.filter((entry) => entry.unsafePath).length,
    totalUncompressedBytes,
    totalPackedBytes,
    expansionRatio: Number(expansionRatio.toFixed(2)),
    suspiciousExpansion: expansionRatio >= SUSPICIOUS_EXPANSION_RATIO,
    truncated: allEntries.length > entries.length,
  };
}

function unpackedAsarPath(filePath) {
  const value = String(filePath || "");
  if (!value.includes(".asar")) return value;
  const unpacked = value.replace(".asar", ".asar.unpacked");
  return fs.existsSync(unpacked) ? unpacked : value;
}

function resolveSevenZipTool(options = {}) {
  const explicit = String(options.sevenZipPath || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const sevenZip = require("7zip-bin");
    const candidate = unpackedAsarPath(sevenZip?.path7za);
    return candidate && fs.existsSync(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

function archiveStat(input = {}) {
  const rawPath = String(input.path || "");
  if (!rawPath) return { error: fail("PATH_REQUIRED") };
  const sourcePath = path.resolve(rawPath);
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) return { error: fail("ARCHIVE_NOT_A_FILE", {}, sourcePath) };
    if (!isArchiveFilePath(sourcePath)) return { error: fail("NOT_AN_ARCHIVE", {}, sourcePath) };
    return { sourcePath, stat };
  } catch (err) {
    return { error: fail("PATH_UNAVAILABLE", { message: err?.message || String(err) }, sourcePath) };
  }
}

function boundedProcessError(result) {
  const detail = String(result?.stderr || result?.error?.message || result?.stdout || "").trim();
  return detail.slice(-2000);
}

function looksBinary(buffer) {
  if (!buffer?.length) return false;
  let controls = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1;
  }
  if (controls / buffer.length > 0.05) return true;
  const text = buffer.toString("utf8");
  const replacements = [...text].filter((char) => char === "\ufffd").length;
  return replacements / Math.max(1, text.length) > 0.01;
}

function listArchive(input = {}, options = {}) {
  const current = archiveStat(input);
  if (current.error) return current.error;
  const tool = resolveSevenZipTool({ ...options, ...input });
  if (!tool) {
    return fail("ARCHIVE_TOOL_UNAVAILABLE", {
      dependency: "7zip-bin",
      message: "Bundled 7-Zip executable was not found.",
    }, current.sourcePath);
  }
  const maxOutputBytes = Math.max(
    64 * 1024,
    Math.min(Number(input.maxOutputBytes || options.maxOutputBytes || DEFAULT_MAX_LIST_OUTPUT_BYTES), 16 * 1024 * 1024),
  );
  const timeout = Math.max(1000, Math.min(Number(input.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS), 60_000));
  const result = spawnSync(tool, ["l", "-slt", "-ba", "--", current.sourcePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: maxOutputBytes,
  });
  if (result.error || result.status !== 0) {
    return fail("ARCHIVE_LIST_FAILED", {
      dependency: "7zip-bin",
      exitCode: result.status,
      message: boundedProcessError(result),
    }, current.sourcePath);
  }
  const manifest = parseSevenZipList(result.stdout, {
    maxEntries: input.maxEntries || options.maxEntries,
  });
  return {
    ok: true,
    sourcePath: current.sourcePath,
    sourceType: "archive",
    kind: "archive",
    byteSize: current.stat.size,
    modifiedAt: current.stat.mtime.toISOString(),
    coverage: manifest.truncated ? "sampled" : "full",
    confidence: "exact",
    wroteFiles: false,
    ...manifest,
  };
}

function readArchiveEntry(input = {}, options = {}) {
  const current = archiveStat(input);
  if (current.error) return current.error;
  const entryPath = String(input.entryPath || "");
  if (!entryPath) return fail("ARCHIVE_ENTRY_REQUIRED", {}, current.sourcePath);
  if (unsafeArchiveEntryPath(entryPath)) {
    return fail("ARCHIVE_ENTRY_UNSAFE_PATH", { entryPath }, current.sourcePath);
  }
  const manifest = listArchive({
    path: current.sourcePath,
    maxEntries: input.maxManifestEntries || 5000,
    timeoutMs: input.timeoutMs,
  }, options);
  if (!manifest.ok) return manifest;
  const entry = manifest.entries.find((item) => item.path === entryPath);
  if (!entry) {
    const detail = manifest.truncated ? { entryPath, manifestTruncated: true } : { entryPath };
    return fail("ARCHIVE_ENTRY_NOT_FOUND", detail, current.sourcePath);
  }
  if (entry.kind !== "file") return fail("ARCHIVE_ENTRY_NOT_A_FILE", { entryPath }, current.sourcePath);
  if (entry.unsafePath) return fail("ARCHIVE_ENTRY_UNSAFE_PATH", { entryPath }, current.sourcePath);
  if (entry.encrypted) return fail("ARCHIVE_ENTRY_ENCRYPTED", { entryPath }, current.sourcePath);

  const maxEntryBytes = Math.max(
    1,
    Math.min(Number(input.maxEntryBytes || options.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES), 16 * 1024 * 1024),
  );
  if (entry.size > maxEntryBytes) {
    return fail("ARCHIVE_ENTRY_TOO_LARGE", {
      entryPath,
      byteSize: entry.size,
      maxEntryBytes,
    }, current.sourcePath);
  }
  const tool = resolveSevenZipTool({ ...options, ...input });
  if (!tool) {
    return fail("ARCHIVE_TOOL_UNAVAILABLE", { dependency: "7zip-bin" }, current.sourcePath);
  }
  const timeout = Math.max(1000, Math.min(Number(input.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS), 60_000));
  const result = spawnSync(tool, ["x", "-so", "-y", "-spd", "--", current.sourcePath, entryPath], {
    encoding: "buffer",
    windowsHide: true,
    timeout,
    maxBuffer: maxEntryBytes + 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    return fail("ARCHIVE_ENTRY_READ_FAILED", {
      entryPath,
      exitCode: result.status,
      message: boundedProcessError(result),
    }, current.sourcePath);
  }
  const content = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
  if (content.length > maxEntryBytes) {
    return fail("ARCHIVE_ENTRY_TOO_LARGE", {
      entryPath,
      byteSize: content.length,
      maxEntryBytes,
    }, current.sourcePath);
  }
  if (looksBinary(content)) {
    return fail("ARCHIVE_ENTRY_BINARY", {
      entryPath,
      byteSize: content.length,
    }, current.sourcePath);
  }
  return {
    ok: true,
    sourcePath: current.sourcePath,
    sourceType: "archive-entry",
    entryPath,
    byteSize: content.length,
    coverage: "full",
    confidence: "exact",
    text: content.toString("utf8"),
    wroteFiles: false,
  };
}

module.exports = {
  ARCHIVE_SUFFIXES,
  archiveKindForPath,
  detectArchiveFormat,
  isArchiveFilePath,
  isSemanticZipContainerPath,
  listArchive,
  parseSevenZipList,
  readArchiveEntry,
  resolveSevenZipTool,
  unsafeArchiveEntryPath,
};
