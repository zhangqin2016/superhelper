#!/usr/bin/env node
// Whether a workbook was recalculated is read from the workbook and from the
// recalculating script's own receipt — never from the words of a command.
// Field case 2026-09-30: the gate looked for "recalc.py" in the command text,
// so any other recalc path counted as none, and a command that ran without
// writing values back counted as done. Real lily_xlsx_recalc.py, real
// LibreOffice (bundled runtime).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveVenvPython, getRuntimeEnvExtras } = require("../src/main/runtime-python.js");
const { assessDocumentDelivery } = require("../src/main/document-delivery-gate.js");
const { ledgerRecalcs, xlsxFormulaState } = require("../src/main/workbook-recalc-receipt.js");

const python = resolveVenvPython();
if (!python) {
  console.log("test-workbook-recalc-receipt: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-recalc-")));
const ledger = path.join(root, "userData", "recalc-receipts");
const env = { ...process.env, ...getRuntimeEnvExtras(), LILY_RECALC_RECEIPTS_DIR: ledger };
const scripts = path.resolve("resources/runtime-scripts");
const book = (file, cells) => execFileSync(python, ["-c", `
import sys, json
from openpyxl import Workbook
wb = Workbook(); ws = wb.active
for ref, value in json.loads(sys.argv[2]).items(): ws[ref] = value
wb.save(sys.argv[1])`, file, JSON.stringify(cells)], { env });
const verdictFor = (file, extra = {}) => assessDocumentDelivery({
  artifacts: [{ path: file, ext: ".xlsx", fileName: path.basename(file), source: "tool_write" }], tools: extra.tools || [],
  recalcReceipts: extra.receipts || [] }).artifacts[0].checks;

try {
  const since = Date.now() - 1000;
  const report = path.join(root, "ws", "report.xlsx");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  book(report, { A1: 1, A2: 2, A3: "=SUM(A1:A2)" });
  assert.deepEqual(xlsxFormulaState(report), { formulas: 1, uncached: 1, errors: 0 }, "openpyxl writes the formula without a value");
  const cmd = { name: "bash", status: "done", input: { command: `python3 recalc.py "${report}"` }, result: "{}" };
  assert.equal(verdictFor(report, { tools: [cmd] }).recalculated, false, "a recalc command does not count while the file has no values");

  // The verified copy is moved over the original — recognised by content.
  const out = path.join(root, "ws", ".recalc");
  const result = JSON.parse(execFileSync(python, [path.join(scripts, "lily_xlsx_recalc.py"), report, "--out-dir", out], { env, encoding: "utf8" }));
  assert.equal(result.status, "verified", JSON.stringify(result));
  fs.copyFileSync(result.output, report);
  const receipts = ledgerRecalcs({ since, dir: ledger });
  assert.equal(receipts.length, 1, "the script recorded the verified bytes");
  const checks = verdictFor(report, { receipts });
  assert.equal(checks.recalculated, true, JSON.stringify(checks.recalculation));
  assert.equal(checks.recalculation.proof, "recalc_receipt");
  assert.equal(verdictFor(report, {}).recalculated, false, "values alone are not proof (a generator may cache placeholders)");

  // Not the same bytes, not the same proof.
  fs.appendFileSync(report, Buffer.from([0]));
  assert.equal(verdictFor(report, { receipts }).recalculated, false, "a changed file needs a new recalc");

  // An error the recalc surfaces is never delivered as recalculated.
  const broken = path.join(root, "ws", "broken.xlsx");
  book(broken, { A1: 1, A2: "=A1/0" });
  let failed = false;
  try { execFileSync(python, [path.join(scripts, "lily_xlsx_recalc.py"), broken, "--out-dir", path.join(root, "ws", ".recalc2")], { env, encoding: "utf8", stdio: "pipe" }); } catch { failed = true; }
  assert(failed, "the script refuses a workbook whose formulas evaluate to errors");
  assert.equal(ledgerRecalcs({ since, dir: ledger }).length, 1, "and records nothing for it");

  // The vendored anthropics-xlsx recalc.py cannot record: its command over a file with values counts.
  const vendored = path.join(root, "ws", "vendored.xlsx");
  fs.copyFileSync(result.output, vendored);
  const vcmd = { name: "bash", status: "done", input: { command: `python3 "/skills/anthropics-xlsx/scripts/recalc.py" "${vendored}"` }, result: "{\"status\": \"success\"}" };
  assert.equal(verdictFor(vendored, { tools: [vcmd] }).recalculation.proof, "vendored_recalc");
  const ours = { name: "bash", status: "done", input: { command: `python3 lily_xlsx_recalc.py "${vendored}"` }, result: "{}" };
  assert.equal(verdictFor(vendored, { tools: [ours] }).recalculated, false, "our own script proves itself by its receipt, not by its name");
  console.log("test-workbook-recalc-receipt: ok (runtime-backed)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
