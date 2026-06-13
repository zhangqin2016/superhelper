#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  extractDocuments,
  hasDocumentInputFiles,
  isDocumentOnlyUserMessage,
} = require("../src/main/document-translator.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures", "office");

// Office/PDF extraction is delegated to the bundled Python runtime. If it's not
// present (e.g. a stripped checkout), skip the runtime-dependent assertions
// rather than fail — but never silently pass them off as covered.
const { resolveVenvPython } = require("../src/main/runtime-python.js");
const haveRuntime = Boolean(resolveVenvPython()) && fs.existsSync(path.join(FIXTURES, "sample.docx"));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-test-"));
const txtPath = path.join(tmpDir, "notes.txt");
fs.writeFileSync(txtPath, "会议纪要：下周发布", "utf8");

const docxPath = path.join(FIXTURES, "sample.docx");
const files = [
  { path: txtPath, name: "notes.txt", isImage: false },
  ...(haveRuntime ? [{ path: docxPath, name: "sample.docx", isImage: false }] : []),
];

assert(hasDocumentInputFiles(files), "expected document input files");
assert(isDocumentOnlyUserMessage("", files), "expected document-only message");
assert(!isDocumentOnlyUserMessage("hi", files), "text + document should not be document-only");

const result = await extractDocuments(files);
assert(result?.ok, `extractDocuments failed: ${JSON.stringify(result)}`);
assert(result.text.includes("会议纪要"), "missing txt extraction");

if (haveRuntime) {
  // Top-tier libraries must preserve real structure: heading + a Markdown table.
  assert(result.text.includes("Quarterly Report"), "missing docx heading");
  assert(/\|\s*Region\s*\|\s*Sales\s*\|/.test(result.text), "docx table not preserved as Markdown");
  assert(result.extractedPaths.length === 2, "expected two extracted paths");

  // Spreadsheet structure (the old regex parser flattened this away).
  const xlsx = await extractDocuments([{ path: path.join(FIXTURES, "sample.xlsx"), name: "s.xlsx" }]);
  assert(xlsx?.ok, `xlsx extraction failed: ${JSON.stringify(xlsx)}`);
  assert(xlsx.text.includes("Sheet: Summary"), "xlsx sheet name missing");
  assert(/\|\s*Widget\s*\|\s*10\s*\|/.test(xlsx.text), "xlsx row not preserved");

  // Presentation per-slide structure.
  const pptx = await extractDocuments([{ path: path.join(FIXTURES, "sample.pptx"), name: "s.pptx" }]);
  assert(pptx?.ok, `pptx extraction failed: ${JSON.stringify(pptx)}`);
  assert(pptx.text.includes("Project Kickoff"), "pptx title missing");

  // Digital PDF (the common case): the text layer is read with pdfplumber and
  // the ruled table must survive as a real Markdown table, not flattened text.
  if (fs.existsSync(path.join(FIXTURES, "sample.pdf"))) {
    const pdf = await extractDocuments([{ path: path.join(FIXTURES, "sample.pdf"), name: "s.pdf" }]);
    assert(pdf?.ok, `pdf extraction failed: ${JSON.stringify(pdf)}`);
    assert(pdf.text.includes("Quarterly Report"), "pdf heading missing");
    assert(/\|\s*Region\s*\|/.test(pdf.text), "pdf table not recovered as Markdown");
  }

  // Scanned PDF (image-only, no text layer): pages with no text layer are
  // rendered with pypdfium2 and OCR'd with RapidOCR. This exercises the OCR
  // branch that replaced the torch-based pipeline — the reachable consumer
  // case (standalone images go through the vision path, not this extractor).
  // The fixture is a rendered copy of sample.pdf, so the same words return.
  if (fs.existsSync(path.join(FIXTURES, "sample_scan.pdf"))) {
    const scan = await extractDocuments([{ path: path.join(FIXTURES, "sample_scan.pdf"), name: "scan.pdf" }]);
    assert(scan?.ok, `scanned-pdf OCR failed: ${JSON.stringify(scan)}`);
    assert(scan.text.includes("Quarterly"), "OCR did not recover heading text");
    assert(scan.text.includes("Region"), "OCR did not recover table header text");
  }

  console.log("test-document-translator: ok (runtime-backed)");
} else {
  assert(result.extractedPaths.length === 1, "expected one extracted path (txt only)");
  console.log("test-document-translator: ok (SKIPPED office/pdf — no bundled runtime)");
}
