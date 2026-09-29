"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { isVisionRaster } = require("../shared/file-kinds.mjs");
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
const LEDGER_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LEDGER_ENTRIES = 5000;

function visionReceiptsDir(userDataDir) {
  return userDataDir ? path.join(userDataDir, LEDGER_NAME) : "";
}

function defaultLedgerDir() {
  try { return visionReceiptsDir(require("electron").app.getPath("userData")); } catch { return ""; }
}

function ledgerFileName(ms) {
  return `${new Date(ms).toISOString().slice(0, 10)}.jsonl`;
}

function pruneLedger(dir, now) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const oldest = ledgerFileName(now - LEDGER_KEEP_DAYS * DAY_MS);
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name >= oldest) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch (err) {
      log.warn("vision ledger prune failed: %s %s", name, err?.message || err);
    }
  }
}

/** Inspections the ledger recorded at or after `since` (epoch ms): [{ path, at }]. */
function ledgerInspections({ since = 0, dir = defaultLedgerDir(), now = Date.now() } = {}) {
  if (!dir || !(Number(since) > 0)) return [];
  pruneLedger(dir, now);
  const entries = [];
  for (let day = Math.floor(since / DAY_MS) * DAY_MS; day <= now; day += DAY_MS) {
    let text = "";
    const file = path.join(dir, ledgerFileName(day));
    try { text = fs.readFileSync(file, "utf8"); } catch (err) {
      if (err?.code !== "ENOENT") log.warn("vision ledger unreadable: %s %s", file, err?.message || err);
      continue;
    }
    let torn = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const receipt = JSON.parse(line);
        if (validReceipt(receipt) && Number(receipt.at) >= since) entries.push({ path: receipt.path, at: Number(receipt.at) });
      } catch { torn += 1; }
      if (entries.length >= MAX_LEDGER_ENTRIES) break;
    }
    if (torn) log.warn("vision ledger: %d unparsable line(s) skipped in %s", torn, file);
    if (entries.length >= MAX_LEDGER_ENTRIES) break;
  }
  return entries;
}

/** Pages lily-vision inspected during the turn `state` describes (the turn's gate reads these). */
function turnVisionInspections(state = {}) {
  try {
    return ledgerInspections({ since: Number(state.startedAt) || 0 });
  } catch (err) {
    log.warn("vision ledger read failed open: %s", err?.message || err);
    return [];
  }
}

module.exports = { ledgerFileName, ledgerInspections, turnVisionInspections, visionInspectionPaths, visionReceiptsDir };
