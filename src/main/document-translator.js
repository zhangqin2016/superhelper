"use strict";

/**
 * Local document text extraction before send — enriches user text so models
 * without native document blocks can still read PDF/Office uploads.
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildEnrichedUserText } = require("./vision-translator");

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".rtf",
]);

const OFFICE_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx",
]);

const LEGACY_OFFICE_EXTENSIONS = new Set([
  ".doc", ".xls", ".ppt",
]);

const EXTRACTABLE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
]);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHARS_PER_FILE = 80_000;
const MAX_TOTAL_CHARS = 200_000;

function truncateText(text, limit = MAX_CHARS_PER_FILE) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[内容已截断，原文共 ${value.length} 字符]`;
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripXmlTags(xml) {
  return decodeXmlEntities(
    String(xml || "")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readZipEntry(zip, entryPath) {
  const JSZip = require("jszip");
  const data = fs.readFileSync(zip);
  const archive = await JSZip.loadAsync(data);
  const entry = archive.file(entryPath);
  if (!entry) return null;
  return entry.async("string");
}

async function extractDocxText(filePath) {
  const xml = await readZipEntry(filePath, "word/document.xml");
  if (!xml) throw new Error("invalid docx");
  return stripXmlTags(xml);
}

async function extractXlsxText(filePath) {
  const shared = await readZipEntry(filePath, "xl/sharedStrings.xml");
  if (!shared) return "";
  const parts = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let match = re.exec(shared);
  while (match) {
    parts.push(decodeXmlEntities(match[1]));
    match = re.exec(shared);
  }
  return parts.join("\n").trim();
}

async function extractPptxText(filePath) {
  const JSZip = require("jszip");
  const data = fs.readFileSync(filePath);
  const archive = await JSZip.loadAsync(data);
  const slidePaths = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const ai = Number.parseInt(a.match(/slide(\d+)/)?.[1] || "0", 10);
      const bi = Number.parseInt(b.match(/slide(\d+)/)?.[1] || "0", 10);
      return ai - bi;
    });
  const chunks = [];
  for (const slidePath of slidePaths) {
    const xml = await archive.file(slidePath).async("string");
    const text = stripXmlTags(xml);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

async function extractPdfText(filePath) {
  const pdfParse = require("pdf-parse");
  const buffer = fs.readFileSync(filePath);
  const result = await pdfParse(buffer);
  return String(result?.text || "").trim();
}

function readPlainTextFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  return buffer.toString("utf8");
}

async function extractDocumentFile(file) {
  const filePath = file.path;
  const ext = path.extname(filePath).toLowerCase();
  const label = file.name || path.basename(filePath);

  if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
    throw new Error(`LEGACY_FORMAT:${ext}`);
  }

  let text = "";
  if (TEXT_EXTENSIONS.has(ext)) {
    text = readPlainTextFile(filePath);
  } else if (ext === ".pdf") {
    text = await extractPdfText(filePath);
  } else if (ext === ".docx") {
    text = await extractDocxText(filePath);
  } else if (ext === ".xlsx") {
    text = await extractXlsxText(filePath);
  } else if (ext === ".pptx") {
    text = await extractPptxText(filePath);
  } else {
    throw new Error(`UNSUPPORTED:${ext}`);
  }

  text = truncateText(text);
  if (!text.trim()) {
    throw new Error("EMPTY_CONTENT");
  }
  return { label, path: filePath, text };
}

function hasDocumentInputFiles(files) {
  return (files || []).some((file) => isExtractableDocumentFile(file));
}

function isExtractableDocumentFile(file) {
  if (!file?.path || file.isImage || !fs.existsSync(file.path)) return false;
  const ext = path.extname(file.path).toLowerCase();
  return EXTRACTABLE_EXTENSIONS.has(ext);
}

function isDocumentOnlyUserMessage(text, files) {
  const { hasVisionInputFiles } = require("./vision-translator");
  if (String(text || "").trim()) return false;
  if (hasVisionInputFiles(files)) return false;
  return hasDocumentInputFiles(files);
}

/**
 * @param {Array<{ path?: string, name?: string, isImage?: boolean }>} files
 * @returns {Promise<{ ok: true, text: string, extractedPaths: string[], keepOriginal: boolean } | { ok: false, reason: string, detail?: string } | null>}
 */
async function extractDocuments(files) {
  const docFiles = (files || []).filter((file) => isExtractableDocumentFile(file));
  if (docFiles.length === 0) return null;

  const sections = [];
  const extractedPaths = [];
  let failed = 0;
  let totalChars = 0;

  for (const file of docFiles) {
    try {
      const result = await extractDocumentFile(file);
      const room = MAX_TOTAL_CHARS - totalChars;
      if (room <= 0) break;
      const text = truncateText(result.text, Math.min(MAX_CHARS_PER_FILE, room));
      totalChars += text.length;
      extractedPaths.push(result.path);
      sections.push(`[文档内容: "${result.label}"]\n${text}`);
    } catch (err) {
      failed += 1;
      console.warn(
        `[document-translator] extract failed for ${file.name || file.path}:`,
        err.message,
      );
    }
  }

  if (sections.length === 0) {
    return {
      ok: false,
      reason: failed === docFiles.length ? "ALL_FAILED" : "NO_CONTENT",
      detail: "文档内容暂时无法读取，请稍后再试。",
    };
  }

  return {
    ok: true,
    text: sections.join("\n\n"),
    extractedPaths,
    keepOriginal: false,
  };
}

module.exports = {
  buildEnrichedUserText,
  extractDocuments,
  hasDocumentInputFiles,
  isDocumentOnlyUserMessage,
  isExtractableDocumentFile,
};
