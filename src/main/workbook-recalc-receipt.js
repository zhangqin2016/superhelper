"use strict";

// Whether a delivered workbook's formulas were recalculated, from the file and
// the recalculating script's own record — not from the words of a command.
// The gate used to look for "recalc.py" in the command text (2026-09-30).
//
// The file decides the negative outright: a formula cell with no cached value
// (openpyxl writes none) or with a cached error (#REF!, #DIV/0!…) is not a
// recalculated workbook, whatever ran. A workbook whose formulas all carry
// values still needs proof, because a generator may cache placeholders
// (xlsxwriter writes 0): lily_xlsx_recalc.py records the verified bytes by
// sha256 in the host ledger (LILY_RECALC_RECEIPTS_DIR), recognised wherever
// the copy was moved; the vendored anthropics-xlsx recalc.py, which cannot
// record anything, is recognised by its command over the file — an interface
// to third-party code, not a guess.
const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { defaultLedgerDir, ledgerDir, readLedger } = require("./host-ledger");

const LEDGER_NAME = "recalc-receipts";
const MAX_BYTES = 20 * 1024 * 1024;
const VENDORED_RECALC_RE = /(?:^|[\/\\\s"'])recalc\.py\b/;

/** { formulas, uncached, errors } of an .xlsx, read from its worksheet parts. */
function xlsxFormulaState(file) {
  const state = { formulas: 0, uncached: 0, errors: 0 };
  let buf;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 22 || stat.size > MAX_BYTES) return state;
    buf = fs.readFileSync(file);
  } catch {
    return state;
  }
  // The zip CENTRAL directory: offsets/sizes there are reliable even when local
  // headers use data descriptors. Only worksheet parts are inflated.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return state;
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && offset + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(name) || (method !== 0 && method !== 8)) continue;
    try {
      const nameLenL = buf.readUInt16LE(localOffset + 26);
      const extraLenL = buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(localOffset + 30 + nameLenL + extraLenL, localOffset + 30 + nameLenL + extraLenL + compressedSize);
      const xml = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
      for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        if (!/<f[\s>/]/.test(cell[2])) continue;
        state.formulas += 1;
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2]);
        if (!value || value[1] === "") state.uncached += 1;
        if (/\bt="e"/.test(cell[1])) state.errors += 1;
      }
    } catch {
      /* an unreadable part neither proves nor disproves anything */
    }
  }
  return state;
}

function recalcReceiptsDir(userDataDir) {
  return ledgerDir(userDataDir, LEDGER_NAME);
}

/** Recalc receipts recorded at or after `since`: [{ output, sha256, formulas, at }]. */
function ledgerRecalcs({ since = 0, dir = defaultLedgerDir(LEDGER_NAME), now = Date.now() } = {}) {
  return readLedger({ dir, since, now, accept: (entry) => entry?.version === 1 && entry.kind === "workbook_recalc"
    && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256) });
}

function sha256Of(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return ""; }
}

/**
 * The recalculation verdict for one workbook.
 * @param {string} file
 * @param {{ receipts?: object[], commands?: string[], mentions?: (text: string) => boolean }} evidence
 */
function workbookRecalculation(file, { receipts = [], commands = [], mentions = () => false } = {}) {
  const state = xlsxFormulaState(file);
  if (!state.formulas) return { needed: false, ok: true, ...state, proof: "" };
  if (state.uncached || state.errors) return { needed: true, ok: false, ...state, proof: "" };
  const digest = receipts.length ? sha256Of(file) : "";
  if (digest && receipts.some((entry) => entry.sha256 === digest)) return { needed: true, ok: true, ...state, proof: "recalc_receipt" };
  if (commands.some((text) => VENDORED_RECALC_RE.test(text) && mentions(text))) return { needed: true, ok: true, ...state, proof: "vendored_recalc" };
  return { needed: true, ok: false, ...state, proof: "" };
}

module.exports = { ledgerRecalcs, recalcReceiptsDir, workbookRecalculation, xlsxFormulaState };
