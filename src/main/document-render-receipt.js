"use strict";

// Where a document was rendered, from the platform's own record instead of
// what a calling script chose to print. render_document.py leaves
// <out_dir>/.lily-render-receipt.json (source path, its mtime and size, the
// page images); the directories to look in are those of the page images this
// turn's vision receipts name. Field case 2026-09-29: a script wrapped
// render_document.py and printed only "xlsx pages 18", so the gate saw no
// page images, eleven vision receipts matched nothing, and every finished
// task started a "文档交付续检" that ended with the same verdict.
const fs = require("node:fs");
const path = require("node:path");
const { visionInspectionPaths } = require("./vision-inspection-receipt.js");

const RECEIPT_NAME = ".lily-render-receipt.json";
const MAX_DIRS = 64;

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

/** The render receipt for `artifactPath` among the page directories this turn looked at, if it is current. */
function renderReceiptFor(artifactPath, tools = []) {
  const dirs = new Set();
  for (const tool of tools) {
    for (const image of visionInspectionPaths(tool)) {
      dirs.add(path.dirname(image));
      if (dirs.size >= MAX_DIRS) break;
    }
  }
  let stat = null;
  try { stat = fs.statSync(artifactPath); } catch { return null; }
  for (const dir of dirs) {
    const receipt = readReceipt(dir);
    if (!receipt || !samePath(receipt.source, artifactPath)) continue;
    // Rendered from the file as it is now: an edit after rendering needs a new render.
    if (receipt.sourceBytes !== stat.size || Math.abs(Number(receipt.sourceMtimeMs) - Math.floor(stat.mtimeMs)) > 1) continue;
    return { images: receipt.images.map(String), pages: Number(receipt.pages) || receipt.images.length };
  }
  return null;
}

/** Every page image this turn's vision receipts name. */
function inspectedImages(tools = []) {
  return tools.flatMap((tool) => visionInspectionPaths(tool));
}

module.exports = { RECEIPT_NAME, inspectedImages, renderReceiptFor, samePath };
