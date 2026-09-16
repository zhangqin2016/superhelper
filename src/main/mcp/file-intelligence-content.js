"use strict";

/**
 * Content indexing for Office and PDF files.
 *
 * Before 2026-09-17 the workspace index gave every .docx/.xlsx/.pptx/.pdf a
 * single `metadata` chunk — File/Type/Size/Index policy — and counted it as
 * indexed. A query for text that really was in the document returned no matches
 * and said nothing about why, so the answer read as "the document does not
 * contain that". The `indexPolicy: paragraph-index` those files carried was a
 * promise no code kept.
 *
 * This is the synchronous sibling of document-translator's extractOfficeText:
 * the indexer is synchronous and partly runs on the main process, so extraction
 * is bounded on every axis and always fails open to the metadata chunk.
 *
 * [gate: document-content-index]
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXTRACTABLE_KINDS = new Set(["pdf", "spreadsheet", "document", "presentation"]);

// Bounds. Extraction spawns Python per file, so a directory index must never be
// able to run away: per-file size and timeout, plus a whole-run file count and
// wall-clock budget. Exceeding any of them leaves the remaining files exactly as
// they were before — metadata-indexed, and reported as such.
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RUN_BUDGET_MS = 120_000;
const DEFAULT_MAX_FILES = 40;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function contentIndexEnabled(env = process.env) {
  return String(env.LILY_INDEX_DOCUMENT_CONTENT ?? "1") !== "0";
}

function isContentExtractable(info = {}) {
  return EXTRACTABLE_KINDS.has(String(info.kind || ""));
}

/**
 * Parse the extractor's stdout. Mirrors classifyExtractionResult in
 * document-translator.js; scripts/test-document-content-index.mjs pins the two
 * together so they cannot drift.
 */
function parseExtractorOutput(stdout) {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout || "")); } catch { parsed = null; }
  if (!parsed) return { error: "EXTRACT_BAD_OUTPUT" };
  if (!parsed.ok) return { error: `EXTRACT_FAILED:${parsed.error || "unknown"}` };
  return { text: String(parsed.text || "") };
}

function resolveExtractor() {
  try {
    const { resolveVenvPython, getBundledPythonEnv } = require("../runtime-python");
    const python = resolveVenvPython();
    if (!python) return { error: "RUNTIME_UNAVAILABLE" };
    const relative = path.join("resources", "runtime-scripts", "extract_document.py");
    const candidates = [];
    if (typeof process.resourcesPath === "string" && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, relative));
    }
    try {
      candidates.push(path.join(require("../config").PROJECT_ROOT, relative));
    } catch { /* config may be unbound outside the app; the bundle path still works */ }
    const script = candidates.find((candidate) => fs.existsSync(candidate));
    if (!script) return { error: "EXTRACTOR_MISSING" };
    return { python, script, env: getBundledPythonEnv() };
  } catch (error) {
    return { error: `RUNTIME_UNAVAILABLE:${error?.message || "unknown"}` };
  }
}

/**
 * A bounded, fail-open content extractor for one index run.
 *
 * @returns {{ extract: (filePath: string, info: object) => ({ text: string } | { reason: string }) }}
 */
function createContentExtractor({
  enabled = contentIndexEnabled(),
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runBudgetMs = DEFAULT_RUN_BUDGET_MS,
  now = Date.now,
  runExtractor = null,
} = {}) {
  const startedAt = now();
  let used = 0;
  let resolved = null;

  function extract(filePath, info = {}) {
    if (!enabled) return { reason: "content_indexing_disabled" };
    if (!isContentExtractable(info)) return { reason: `kind_not_extractable:${info.kind || "unknown"}` };
    if (used >= maxFiles) return { reason: "run_file_budget_reached" };
    if (now() - startedAt >= runBudgetMs) return { reason: "run_time_budget_reached" };
    const size = Number(info.bytes ?? info.size ?? 0);
    if (size > maxFileBytes) return { reason: `file_too_large:${size}` };

    if (runExtractor) {
      used += 1;
      try {
        const outcome = runExtractor(filePath, { timeoutMs });
        if (outcome?.error) return { reason: outcome.error };
        const text = String(outcome?.text || "").trim();
        return text ? { text } : { reason: "extracted_empty" };
      } catch (error) {
        return { reason: `EXTRACT_FAILED:${error?.message || "unknown"}` };
      }
    }

    if (!resolved) resolved = resolveExtractor();
    if (resolved.error) return { reason: resolved.error };

    used += 1;
    let stdout = "";
    try {
      stdout = execFileSync(resolved.python, [resolved.script, filePath], {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: resolved.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      // execFileSync throws on a non-zero exit, but the script reports its own
      // failures as JSON on stdout, so read that before calling it a crash.
      const captured = String(error?.stdout || "");
      if (captured) {
        const parsedFailure = parseExtractorOutput(captured);
        if (parsedFailure.text) return { text: parsedFailure.text };
        return { reason: parsedFailure.error };
      }
      const timedOut = error?.killed === true || error?.signal === "SIGTERM";
      return { reason: timedOut ? `EXTRACT_TIMEOUT:${timeoutMs}ms` : `EXTRACT_FAILED:${error?.message || "unknown"}` };
    }

    const parsed = parseExtractorOutput(stdout);
    if (parsed.error) return { reason: parsed.error };
    const text = String(parsed.text || "").trim();
    return text ? { text } : { reason: "extracted_empty" };
  }

  return { extract };
}

module.exports = {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RUN_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  EXTRACTABLE_KINDS,
  contentIndexEnabled,
  createContentExtractor,
  isContentExtractable,
  parseExtractorOutput,
};
