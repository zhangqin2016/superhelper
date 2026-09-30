#!/usr/bin/env node
// Every render's receipt is found, and a page byte-identical to an inspected
// page counts as inspected. Field case 2026-09-30: the check round inspected
// every .docx/.pptx page and confirmed their PDF exports rendered identically
// (MD5); the PDFs' own receipts were never looked up (only folders of pages
// seen inspected were searched), one loop's output was read as each PDF's
// pages — "0/38 inspected" for a 7-page PDF — and the finished check still
// ended "自动检查未全部完成".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assessDocumentDelivery } = require("../src/main/document-delivery-gate.js");
const { ledgerRenders } = require("../src/main/document-render-receipt.js");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-render-ledger-")));
const ledger = path.join(root, "userData", "render-receipts");
const out = path.join(root, "ws", "output");
fs.mkdirSync(out, { recursive: true });
const docx = path.join(out, "报告.docx");
const pdf = path.join(out, "报告.pdf");
fs.writeFileSync(docx, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("[Content_Types].xml word/document.xml")]));
fs.writeFileSync(pdf, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const pagesOf = (dir, n, salt = "") => {
  fs.mkdirSync(dir, { recursive: true });
  return Array.from({ length: n }, (_, i) => {
    const file = path.join(dir, `page-${i + 1}.png`);
    fs.writeFileSync(file, `png-page-${i + 1}${salt}`);
    return file;
  });
};
const docxPages = pagesOf(path.join(root, "ws", ".lily-work", "render", "report_docx"), 3);
const pdfPages = pagesOf(path.join(root, "ws", ".lily-work", "render", "report_pdf"), 3);
// The real receipt writer, with the host's ledger named as the app names it.
const writeReceipt = (source, images) => execFileSync("python3", ["-c",
  "import sys, json; sys.path.insert(0, 'resources/runtime-scripts'); import render_document as r; r._write_receipt(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))",
  source, path.dirname(images[0]), JSON.stringify(images)], { env: { ...process.env, LILY_RENDER_RECEIPTS_DIR: ledger } });

try {
  const turnStart = Date.now() - 1000;
  writeReceipt(docx, docxPages);
  writeReceipt(pdf, pdfPages);
  const renderReceipts = ledgerRenders({ since: turnStart, dir: ledger });
  assert.equal(renderReceipts.length, 2, "render_document.py recorded both receipts in the host ledger");

  // One loop rendered both files; its output lists every page of both.
  const loop = { name: "bash", status: "done", startedAt: turnStart, input: { command: `for f in "${docx}" "${pdf}"; do python3 render_document.py "$f" ...; done` },
    result: JSON.stringify({ ok: true, images: [...docxPages, ...pdfPages] }) };
  const artifacts = [docx, pdf].map((file) => ({ path: file, ext: path.extname(file), fileName: path.basename(file), source: "tool_write" }));
  const visionInspections = docxPages.map((page) => ({ path: page, at: Date.now() })); // only the .docx pages were looked at
  const verdict = (renders) => assessDocumentDelivery({ artifacts, tools: [loop], visionInspections, renderReceipts: renders });

  const field = verdict([]);
  assert.equal(field.ok, false, "without the render ledger: the field verdict");
  const verified = verdict(renderReceipts);
  const pdfCheck = verified.artifacts.find((item) => item.path === pdf).checks;
  assert.equal(pdfCheck.pageCount, 3, "the PDF's own receipt gives its own pages, not the loop's");
  assert.deepEqual(pdfCheck.visual, { ok: true, inspected: 3, total: 3 }, "identical pages count as inspected");
  assert.equal(verified.ok, true, JSON.stringify(verified.missing));

  // Not looser: identical pages within ONE render do not vouch for each other.
  const blank = pagesOf(path.join(root, "ws", ".lily-work", "render", "blank"), 2, "-blank");
  fs.writeFileSync(blank[1], fs.readFileSync(blank[0]));
  const blankDoc = path.join(out, "空白.docx");
  fs.writeFileSync(blankDoc, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("[Content_Types].xml")]));
  writeReceipt(blankDoc, blank);
  const blankVerdict = assessDocumentDelivery({ artifacts: [{ path: blankDoc, ext: ".docx", fileName: "空白.docx", source: "tool_write" }], tools: [],
    visionInspections: [{ path: blank[0], at: Date.now() }], renderReceipts: ledgerRenders({ since: turnStart, dir: ledger }) });
  assert.deepEqual(blankVerdict.missing, ["visual_inspection"], "a second identical page of the same render is not taken as seen");
  // Not looser: one PDF page that differs was never seen.
  fs.writeFileSync(pdfPages[2], "png-page-3-different");
  const oneDiffers = verdict(renderReceipts).artifacts.find((item) => item.path === pdf);
  assert.deepEqual(oneDiffers.missing, ["visual_inspection"], "a page with other content still needs inspecting");
  fs.writeFileSync(pdfPages[2], "png-page-3");
  // A receipt from before the file last changed is not this file's render.
  fs.appendFileSync(pdf, "% edited\n");
  assert.equal(verdict(renderReceipts).artifacts.find((item) => item.path === pdf).ok, false, "an edit after rendering needs a new render");
  console.log("test-render-ledger-content-match: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
