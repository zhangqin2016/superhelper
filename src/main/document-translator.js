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
const LARGE_DOCUMENT_INDEX_BYTES = 20 * 1024 * 1024;
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
  // Put any installed runtime packs (e.g. the pro-pdf Docling engine) on
  // PYTHONPATH so extract_document.py's lazy import upgrades automatically.
  const packPaths = require("./runtime-packs").getRuntimePackPythonPaths();
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

function shouldUseLargeDocumentIndex(filePath) {
  try {
    return fs.statSync(filePath).size > LARGE_DOCUMENT_INDEX_BYTES;
  } catch {
    return false;
  }
}

function reportProgress(onProgress, event = {}) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({
      ...event,
      ts: Date.now(),
    });
  } catch {
    // Progress is observability only; never let UI reporting break extraction.
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildLargeDocumentIndexNotice(filePath, label) {
  const { inspectPath } = require("./mcp/file-intelligence-core");
  const { indexPath } = require("./mcp/file-intelligence-index");
  let info;
  try {
    info = inspectPath({ path: filePath }, { largeThresholdBytes: LARGE_DOCUMENT_INDEX_BYTES });
  } catch (err) {
    info = {
      ok: false,
      kind: path.extname(filePath).slice(1) || "unknown",
      byteSize: 0,
      error: err?.message || "INSPECT_FAILED",
      recommendedActions: ["sample-metadata"],
    };
  }
  let indexed;
  try {
    indexed = indexPath({ path: filePath });
  } catch (err) {
    indexed = { ok: false, error: err?.message || "INDEX_FAILED" };
  }
  const requiredPacks = Array.isArray(info.requiredPacks) ? info.requiredPacks : [];
  const recommendedActions = Array.isArray(info.recommendedActions) ? info.recommendedActions : [];
  return {
    label,
    path: filePath,
    largeDocument: true,
    indexPolicy: info.indexPolicy || "",
    requiredPacks,
    recommendedActions,
    metadataIndexId: indexed.ok ? indexed.indexId : "",
    text: [
      `Large document indexed handling: "${label}"`,
      `Source file path: ${filePath}`,
      `File type: ${info.kind || "unknown"}`,
      `Size: ${info.byteSize || 0} bytes`,
      info.indexPolicy ? `Index policy: ${info.indexPolicy}` : "",
      requiredPacks.length ? `Required dependency packs: ${requiredPacks.join(", ")}` : "",
      recommendedActions.length ? `Recommended actions: ${recommendedActions.join(", ")}` : "",
      indexed.ok ? `Workspace metadata index: ${indexed.indexId}` : `Workspace metadata index unavailable: ${indexed.error || "UNKNOWN"}`,
      "",
      "This large file was not fully extracted before sending so the conversation stays usable. Query the workspace/file index for evidence, or install the required dependency packs for deeper extraction.",
    ].filter(Boolean).join("\n"),
  };
}

function buildDocumentFailureNotice(filePath, label, error) {
  const { inspectPath } = require("./mcp/file-intelligence-core");
  const { indexPath } = require("./mcp/file-intelligence-index");
  let info;
  try {
    info = inspectPath({ path: filePath }, { largeThresholdBytes: LARGE_DOCUMENT_INDEX_BYTES });
  } catch (err) {
    info = {
      ok: false,
      kind: path.extname(filePath).slice(1) || "unknown",
      byteSize: 0,
      error: err?.message || "INSPECT_FAILED",
      recommendedActions: ["retry-extraction"],
    };
  }
  let indexed;
  try {
    indexed = indexPath({ path: filePath });
  } catch (err) {
    indexed = { ok: false, error: err?.message || "INDEX_FAILED" };
  }
  const requiredPacks = Array.isArray(info.requiredPacks) ? info.requiredPacks : [];
  const recommendedActions = Array.isArray(info.recommendedActions) ? info.recommendedActions : [];
  return {
    label,
    path: filePath,
    failedDocument: true,
    indexPolicy: info.indexPolicy || "",
    requiredPacks,
    recommendedActions,
    metadataIndexId: indexed.ok ? indexed.indexId : "",
    text: [
      `Document extraction fallback: "${label}"`,
      `Source file path: ${filePath}`,
      `File type: ${info.kind || "unknown"}`,
      `Size: ${info.byteSize || 0} bytes`,
      `Extraction error: ${error || "EXTRACT_FAILED"}`,
      info.indexPolicy ? `Index policy: ${info.indexPolicy}` : "",
      requiredPacks.length ? `Required dependency packs: ${requiredPacks.join(", ")}` : "",
      recommendedActions.length ? `Recommended actions: ${recommendedActions.join(", ")}` : "",
      indexed.ok ? `Workspace metadata index: ${indexed.indexId}` : `Workspace metadata index unavailable: ${indexed.error || "UNKNOWN"}`,
      "",
      "This is not document content. Do not summarize, quote, or infer facts from this file based only on this metadata. If the user asked about the document, explain that content extraction failed and use available tools, dependency packs, or the source file path to retry.",
    ].filter(Boolean).join("\n"),
  };
}

function buildDocumentFailureSection(item) {
  const result = buildDocumentFailureNotice(item.path, item.label, item.error);
  return [
    `[Document unavailable: "${result.label}"]`,
    `Source file path: ${result.path}`,
    "",
    result.text,
  ].join("\n");
}

async function extractDocumentFile(file) {
  const filePath = file.path;
  const ext = path.extname(filePath).toLowerCase();
  const label = file.name || path.basename(filePath);

  if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
    throw new Error(`LEGACY_FORMAT:${ext}`);
  }

  let text = "";
  if (shouldUseLargeDocumentIndex(filePath)) {
    return buildLargeDocumentIndexNotice(filePath, label);
  }
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
 * @returns {Promise<{ ok: true, text: string, extractedPaths: string[], keepOriginal: boolean, degraded?: boolean } | { ok: false, reason: string, detail?: string } | null>}
 */
async function extractDocuments(files, options = {}) {
  const docFiles = (files || []).filter((file) => isExtractableDocumentFile(file));
  if (docFiles.length === 0) return null;
  const onProgress = options?.onProgress;

  const sections = [];
  const indexedDocuments = [];
  const extractedPaths = [];
  const failedDocuments = [];
  let failed = 0;
  let totalChars = 0;
  let processed = 0;

  reportProgress(onProgress, {
    phase: "started",
    total: docFiles.length,
    processed,
  });
  await yieldToEventLoop();

  for (const file of docFiles) {
    const label = file.name || path.basename(file.path);
    reportProgress(onProgress, {
      phase: "file-started",
      label,
      path: file.path,
      total: docFiles.length,
      processed,
    });
    await yieldToEventLoop();
    try {
      const result = await extractDocumentFile(file);
      processed += 1;
      reportProgress(onProgress, {
        phase: result.largeDocument ? "file-indexed" : "file-extracted",
        label: result.label,
        path: result.path,
        total: docFiles.length,
        processed,
        indexPolicy: result.indexPolicy || "",
        metadataIndexId: result.metadataIndexId || "",
        requiredPacks: result.requiredPacks || [],
      });
      await yieldToEventLoop();
      const room = MAX_TOTAL_CHARS - totalChars;
      if (room <= 0) break;
      const text = truncateText(result.text, Math.min(MAX_CHARS_PER_FILE, room));
      totalChars += text.length;
      extractedPaths.push(result.path);
      indexedDocuments.push(result);
      sections.push(
        [
          `[Document: "${result.label}"]`,
          `Source file path: ${result.path}`,
          "",
          text,
        ].join("\n"),
      );
    } catch (err) {
      processed += 1;
      failed += 1;
      failedDocuments.push({
        label,
        path: file.path,
        error: err?.message || "EXTRACT_FAILED",
      });
      reportProgress(onProgress, {
        phase: "file-failed",
        label,
        path: file.path,
        total: docFiles.length,
        processed,
        error: err?.message || "EXTRACT_FAILED",
      });
      await yieldToEventLoop();
      console.warn(
        `[document-translator] extract failed for ${file.name || file.path}:`,
        err.message,
      );
    }
  }

  if (sections.length === 0) {
    const fallbackSections = failedDocuments.map((item) => buildDocumentFailureSection(item));
    reportProgress(onProgress, {
      phase: "done",
      total: docFiles.length,
      processed,
      failed,
      extracted: 0,
    });
    if (fallbackSections.length) {
      return {
        ok: true,
        text: fallbackSections.join("\n\n"),
        documentIndex: null,
        documentIndexText: "",
        extractedPaths: [],
        keepOriginal: true,
        degraded: true,
      };
    }
    return {
      ok: false,
      reason: failed === docFiles.length ? "ALL_FAILED" : "NO_CONTENT",
      detail: "Unable to read document content at this time. Please try again later.",
    };
  }

  for (const item of failedDocuments) {
    sections.push(buildDocumentFailureSection(item));
  }

  let documentIndex = null;
  let documentIndexText = "";
  try {
    const {
      buildDocumentQueryIndex,
      formatDocumentQueryIndexForPrompt,
    } = require("./document-query-index");
    documentIndex = buildDocumentQueryIndex(indexedDocuments);
    documentIndexText = formatDocumentQueryIndexForPrompt(documentIndex);
  } catch (err) {
    console.warn("[document-translator] document query index failed:", err?.message || err);
  }

  reportProgress(onProgress, {
    phase: "done",
    total: docFiles.length,
    processed,
    failed,
    extracted: indexedDocuments.length,
  });

  return {
    ok: true,
    text: sections.join("\n\n"),
    documentIndex,
    documentIndexText,
    extractedPaths,
    keepOriginal: false,
    degraded: failedDocuments.length > 0,
  };
}

module.exports = {
  buildEnrichedUserText,
  extractDocuments,
  hasDocumentInputFiles,
  isDocumentOnlyUserMessage,
  isExtractableDocumentFile,
};
