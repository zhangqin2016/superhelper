"use strict";

/**
 * Local document text extraction before send — enriches user text so models
 * without native document blocks can still read PDF/Office uploads.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { buildEnrichedUserText } = require("./vision-translator");
const { resolveVenvPython } = require("./runtime-python");
const { PROJECT_ROOT } = require("./config");

const PYTHON_EXTRACT_TIMEOUT_MS = 180_000;
const MAX_EXTRACT_OUTPUT_BYTES = 32 * 1024 * 1024;

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
  return `${value.slice(0, limit)}\n\n[Content truncated, original length: ${value.length} characters]`;
}

function extractorScriptPath() {
  const rel = path.join("resources", "runtime-scripts", "extract_document.py");
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, rel));
  }
  candidates.push(path.join(PROJECT_ROOT, rel));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Extract PDF/Office content via the bundled Python libraries (python-docx,
 * openpyxl, python-pptx, pdfplumber; RapidOCR for scanned pages) — tables
 * survive as Markdown. We do not hand-parse Office XML in JS: that flattened
 * structure and broke on real files. Throws a clear reason if the runtime or
 * script is unavailable.
 */
function extractOfficeText(filePath) {
  const python = resolveVenvPython();
  if (!python) throw new Error("RUNTIME_UNAVAILABLE");
  const script = extractorScriptPath();
  if (!script) throw new Error("EXTRACTOR_MISSING");

  const env = { ...process.env };
  // Put any installed capability packs (e.g. the pro-pdf Docling engine) on
  // PYTHONPATH so extract_document.py's lazy import upgrades automatically.
  const packPaths = require("./document-packs").getDocumentPackPythonPaths();
  if (packPaths.length) {
    env.PYTHONPATH = [...packPaths, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }

  return new Promise((resolve, reject) => {
    execFile(
      python,
      [script, filePath],
      { timeout: PYTHON_EXTRACT_TIMEOUT_MS, maxBuffer: MAX_EXTRACT_OUTPUT_BYTES, env },
      (err, stdout) => {
        if (err) return reject(new Error(`EXTRACT_FAILED:${err.message}`));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error("EXTRACT_BAD_OUTPUT"));
        }
        if (!parsed.ok) return reject(new Error(parsed.error || "EXTRACT_FAILED"));
        resolve(String(parsed.text || ""));
      },
    );
  });
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
  } else if (OFFICE_EXTENSIONS.has(ext)) {
    text = await extractOfficeText(filePath);
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
      sections.push(`[Document: "${result.label}"]\n${text}`);
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
      detail: "Unable to read document content at this time. Please try again later.",
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
