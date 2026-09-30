"use strict";
const { isVisionRaster } = require("../shared/file-kinds.mjs");
const { defaultLedgerDir, ledgerDir, ledgerFileName, readLedger } = require("./host-ledger");
const { getLogger } = require("./logger");

const log = getLogger("vision-inspection-receipt");

// A completed local vision invocation names the image it actually submitted.
// Free-form model claims and command names are not inspection evidence.
function validReceipt(receipt) {
  return receipt?.version === 1 && receipt.kind === "image_inspection" && receipt.ok === true
    && typeof receipt.path === "string" && /^(?:[a-z]:[\\/]|\/)/i.test(receipt.path)
    && isVisionRaster(receipt.path);
}

function visionInspectionPaths(tool = {}) {
  const output = tool.result ?? tool.output ?? tool.content;
  const text = typeof output === "string" ? output : String(output?.stdout || output?.output || "");
  const paths = [];
  for (const line of text.slice(0, 65536).split(/\r?\n/)) {
    if (!line.startsWith("LILY_VISION_RECEIPT ")) continue;
    try {
      const receipt = JSON.parse(line.slice("LILY_VISION_RECEIPT ".length));
      if (validReceipt(receipt)) paths.push(receipt.path);
    } catch { /* Old or malformed output retains the existing unverified state. */ }
  }
  return paths;
}

// The same receipt, as vision.js also records it in the host-named ledger
// (LILY_VISION_RECEIPTS_DIR, one UTC-dated JSONL file per day). The printed
// line is the model's to keep or drop: field case 2026-09-30, the model piped
// every call through `grep -v LILY_VISION_RECEIPT`, so 30 pages it really
// inspected counted as none and each finished task started a 文档交付续检.
const LEDGER_NAME = "vision-receipts";

function visionReceiptsDir(userDataDir) {
  return ledgerDir(userDataDir, LEDGER_NAME);
}

/** Inspections the ledger recorded at or after `since` (epoch ms): [{ path, at }]. */
function ledgerInspections({ since = 0, dir = defaultLedgerDir(LEDGER_NAME), now = Date.now() } = {}) {
  return readLedger({ dir, since, now, accept: validReceipt }).map((entry) => ({ path: entry.path, at: Number(entry.at) }));
}

/** Pages lily-vision inspected during the turn `state` describes (the turn's gate reads these). */
function turnVisionInspections(state = {}) {
  if (process.env.LILY_VISION_LEDGER === "0") return []; // printed receipts only, as before 2026-09-30
  try {
    return ledgerInspections({ since: Number(state.startedAt) || 0 });
  } catch (err) {
    log.warn("vision ledger read failed open: %s", err?.message || err);
    return [];
  }
}

module.exports = { ledgerFileName, ledgerInspections, turnVisionInspections, visionInspectionPaths, visionReceiptsDir };
