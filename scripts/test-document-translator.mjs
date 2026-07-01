#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import JSZip from "jszip";
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
const commentedDocxPath = path.join(tmpDir, "commented.docx");
const files = [
  { path: txtPath, name: "notes.txt", isImage: false },
  ...(haveRuntime ? [{ path: docxPath, name: "sample.docx", isImage: false }] : []),
];

async function writeCommentedDocx(filePath) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t>Proposal body</w:t></w:r></w:p>
  <w:p><w:r><w:commentRangeStart w:id="0"/><w:t>Scope statement</w:t><w:commentRangeEnd w:id="0"/></w:r><w:r><w:commentReference w:id="0"/></w:r></w:p>
  <w:sectPr/>
</w:body></w:document>`,
  );
  zip.file(
    "word/comments.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Reviewer" w:date="2026-06-30T00:00:00Z">
    <w:p><w:r><w:t>Please clarify the implementation scope.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  );
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

assert(hasDocumentInputFiles(files), "expected document input files");
assert(isDocumentOnlyUserMessage("", files), "expected document-only message");
assert(!isDocumentOnlyUserMessage("hi", files), "text + document should not be document-only");

const result = await extractDocuments(files);
assert(result?.ok, `extractDocuments failed: ${JSON.stringify(result)}`);
assert(result.text.includes("会议纪要"), "missing txt extraction");

const largeXlsxPath = path.join(tmpDir, "large.xlsx");
fs.writeFileSync(largeXlsxPath, Buffer.alloc(21 * 1024 * 1024, 65));
const largeProgress = [];
const largeXlsx = await extractDocuments(
  [{ path: largeXlsxPath, name: "large.xlsx", isImage: false }],
  { onProgress: (event) => largeProgress.push(event) },
);
assert(largeXlsx?.ok, `large xlsx should not block or fail extraction: ${JSON.stringify(largeXlsx)}`);
assert(largeXlsx.text.includes("Large document indexed handling"), "large xlsx should return an index notice instead of full extraction");
assert(largeXlsx.text.includes("sheet-index"), "large xlsx notice should preserve sheet-index routing");
assert(largeXlsx.text.includes("large-document"), "large xlsx notice should mention required large-document dependency");
assert(largeProgress.some((event) => event.phase === "file-started" && event.label === "large.xlsx"), "large xlsx should report file-started progress");
assert(largeProgress.some((event) => event.phase === "file-indexed" && event.label === "large.xlsx"), "large xlsx should report index progress");
assert(largeProgress.some((event) => event.phase === "done" && event.processed === 1), "large xlsx should report done progress");

const badPdfPath = path.join(tmpDir, "bad.pdf");
fs.writeFileSync(badPdfPath, "not a valid pdf", "utf8");
const badProgress = [];
const badPdf = await extractDocuments(
  [{ path: badPdfPath, name: "bad.pdf", isImage: false }],
  { onProgress: (event) => badProgress.push(event) },
);
assert(badPdf?.ok, `bad pdf should degrade instead of failing the whole turn: ${JSON.stringify(badPdf)}`);
assert(badPdf.degraded === true, "bad pdf fallback should be marked degraded");
assert(badPdf.keepOriginal === true, "bad pdf fallback should keep the original file attached");
assert(badPdf.extractedPaths.length === 0, "bad pdf fallback should not pretend extraction succeeded");
assert(badPdf.text.includes("Document extraction fallback"), "bad pdf fallback context missing");
assert(badPdf.text.includes("Do not summarize"), "bad pdf fallback should block blind summaries");
assert(badPdf.text.includes("bad.pdf"), "bad pdf fallback should include the file label");
assert(badProgress.some((event) => event.phase === "file-failed" && event.label === "bad.pdf"), "bad pdf should report file-failed progress");
assert(badProgress.some((event) => event.phase === "done" && event.failed === 1 && event.extracted === 0), "bad pdf should report degraded done progress");

const mixed = await extractDocuments([
  { path: txtPath, name: "notes.txt", isImage: false },
  { path: badPdfPath, name: "bad.pdf", isImage: false },
]);
assert(mixed?.ok, `mixed success/failure should still produce a usable context: ${JSON.stringify(mixed)}`);
assert(mixed.degraded === true, "mixed document extraction should mark partial failure as degraded");
assert(mixed.text.includes("会议纪要"), "mixed extraction should keep successfully extracted content");
assert(mixed.text.includes("Document extraction fallback"), "mixed extraction should include fallback for failed files");
assert(mixed.extractedPaths.includes(txtPath), "mixed extraction should record successful extracted path");
assert(!mixed.extractedPaths.includes(badPdfPath), "mixed extraction should not mark failed file as extracted");

if (haveRuntime) {
  // Top-tier libraries must preserve real structure: heading + a Markdown table.
  assert(result.text.includes("Quarterly Report"), "missing docx heading");
  assert(result.text.includes(`Source file path: ${docxPath}`), "document extraction should expose source path for raw attachment follow-up");
  assert(/\|\s*Region\s*\|\s*Sales\s*\|/.test(result.text), "docx table not preserved as Markdown");
  assert(result.extractedPaths.length === 2, "expected two extracted paths");

  await writeCommentedDocx(commentedDocxPath);
  const commented = await extractDocuments([{ path: commentedDocxPath, name: "commented.docx", isImage: false }]);
  assert(commented?.ok, `commented docx extraction failed: ${JSON.stringify(commented)}`);
  assert(commented.text.includes("## Comments"), "docx comments section missing");
  assert(commented.text.includes("Please clarify the implementation scope."), "docx comment text missing");
  assert(commented.text.includes("Anchor: Scope statement"), "docx comment anchor missing");

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
