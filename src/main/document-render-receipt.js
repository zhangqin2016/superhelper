"use strict";

// Where a document was rendered, from the platform's own record instead of
// what a calling script chose to print. render_document.py leaves
// <out_dir>/.lily-render-receipt.json (source path, its mtime and size, the
// page images); the directories to look in are those of the page images this
// turn's vision receipts name. Field case 2026-09-29: a script wrapped
// render_document.py and printed only "xlsx pages 18", so the gate saw no
// page images, eleven vision receipts matched nothing, and every finished
// task started a "文档交付续检" that ended with the same verdict.
//
// The render ledger (LILY_RENDER_RECEIPTS_DIR) names every receipt written this
// turn, so a file's receipt is found even when none of its own pages was
// inspected (2026-09-30: a PDF export whose pages were byte-identical to the
// inspected .docx render was never looked up).
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { visionInspectionPaths } = require("./vision-inspection-receipt.js");
const { defaultLedgerDir, ledgerDir, readLedger } = require("./host-ledger");
const { getLogger } = require("./logger");

const log = getLogger("document-render-receipt");
const RECEIPT_NAME = ".lily-render-receipt.json";
const RENDER_LEDGER_NAME = "render-receipts";
const MAX_DIRS = 64;
const MAX_HASHES = 200;
const MAX_HASH_BYTES = 25 * 1024 * 1024;

/** macOS hands out decomposed (NFD) names; Python and Node may compose them. */
function samePath(left = "", right = "") {
  const norm = (value) => path.resolve(String(value || "")).normalize("NFC");
  return Boolean(left && right) && norm(left) === norm(right);
}

function readReceipt(dir) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, RECEIPT_NAME), "utf8"));
    if (receipt?.version !== 1 || receipt.kind !== "document_render" || !Array.isArray(receipt.images)) return null;
    return receipt;
  } catch {
    return null;
  }
}

/**
 * The render receipt for `artifactPath` among the page directories this turn
 * looked at, if it is current. `ledgerImages`: the pages the host's vision
 * ledger recorded this turn, which the printed receipts may lack.
 */
function renderReceiptFor(artifactPath, tools = [], ledgerImages = [], renderEntries = []) {
  const dirs = new Set();
  // The ledger's own entries for this file, newest first.
  for (const entry of [...renderEntries].reverse()) {
    if (samePath(entry.source, artifactPath) && entry.receipt) dirs.add(path.dirname(String(entry.receipt)));
  }
  for (const image of inspectedImages(tools, ledgerImages)) {
    dirs.add(path.dirname(image));
    if (dirs.size >= MAX_DIRS) break;
  }
  let stat = null;
  try { stat = fs.statSync(artifactPath); } catch { return null; }
  for (const dir of dirs) {
    const receipt = readReceipt(dir);
    if (!receipt || !samePath(receipt.source, artifactPath)) continue;
    // Rendered from the file as it is now: an edit after rendering needs a new render.
    if (receipt.sourceBytes !== stat.size || Math.abs(Number(receipt.sourceMtimeMs) - Math.floor(stat.mtimeMs)) > 1) continue;
    return {
      images: receipt.images.map(String),
      pages: Number(receipt.pages) || receipt.images.length,
      renderedAtMs: Number(receipt.renderedAtMs) || 0,
      // render_document.py's OOXML schema check of the same file (absent on old receipts).
      package: receipt.package && typeof receipt.package === "object" ? receipt.package : null,
    };
  }
  return null;
}

/** Every page image this turn's vision receipts name, printed or in the ledger. */
function inspectedImages(tools = [], ledgerImages = []) {
  return [...new Set([...tools.flatMap((tool) => visionInspectionPaths(tool)), ...ledgerImages.map(String)])];
}

function renderReceiptsDir(userDataDir) {
  return ledgerDir(userDataDir, RENDER_LEDGER_NAME);
}

/** Receipts render_document.py recorded at or after `since`: [{ source, receipt, at }]. */
function ledgerRenders({ since = 0, dir = defaultLedgerDir(RENDER_LEDGER_NAME), now = Date.now() } = {}) {
  return readLedger({ dir, since, now, accept: (entry) => entry?.version === 1 && entry.kind === "document_render"
    && typeof entry.source === "string" && typeof entry.receipt === "string" });
}

/**
 * Rendered pages whose bytes are identical to a page that was inspected: the
 * same picture, so the same inspection (a PDF export rendered pixel for pixel
 * like its inspected .docx). Sizes first; only same-size pairs are hashed.
 */
function inspectedByContent(renderedImages = [], inspected = []) {
  const hashes = new Map();
  let budget = MAX_HASHES;
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return -1; } };
  const hashOf = (file) => {
    if (hashes.has(file)) return hashes.get(file);
    if (budget <= 0) return "";
    budget -= 1;
    let digest = "";
    try {
      if (sizeOf(file) <= MAX_HASH_BYTES) digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch (err) {
      log.warn("page image unreadable for content match: %s %s", file, err?.message || err);
    }
    hashes.set(file, digest);
    return digest;
  };
  const bySize = new Map();
  for (const file of inspected) {
    const size = sizeOf(file);
    if (size > 0) bySize.set(size, [...(bySize.get(size) || []), file]);
  }
  const matched = [];
  for (const page of renderedImages) {
    const candidates = bySize.get(sizeOf(page)) || [];
    if (!candidates.length) continue;
    const digest = hashOf(page);
    if (digest && candidates.some((file) => hashOf(file) === digest)) matched.push(page);
  }
  return matched;
}

module.exports = { RECEIPT_NAME, inspectedByContent, inspectedImages, ledgerRenders, renderReceiptFor, renderReceiptsDir, samePath };
