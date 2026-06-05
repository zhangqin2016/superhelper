#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const {
  extractDocuments,
  hasDocumentInputFiles,
  isDocumentOnlyUserMessage,
} = require("../src/main/document-translator.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-test-"));
const txtPath = path.join(tmpDir, "notes.txt");
fs.writeFileSync(txtPath, "会议纪要：下周发布", "utf8");

const docxPath = path.join(tmpDir, "report.docx");
const zip = new JSZip();
zip.file(
  "word/document.xml",
  "<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> World</w:t></w:r></w:p></w:body></w:document>",
);
fs.writeFileSync(docxPath, await zip.generateAsync({ type: "nodebuffer" }));

const files = [
  { path: txtPath, name: "notes.txt", isImage: false },
  { path: docxPath, name: "report.docx", isImage: false },
];

if (!hasDocumentInputFiles(files)) {
  throw new Error("expected document input files");
}
if (!isDocumentOnlyUserMessage("", files)) {
  throw new Error("expected document-only message");
}
if (isDocumentOnlyUserMessage("hi", files)) {
  throw new Error("text + document should not be document-only");
}

const result = await extractDocuments(files);
if (!result?.ok) {
  throw new Error(`extractDocuments failed: ${JSON.stringify(result)}`);
}
if (!result.text.includes("会议纪要")) {
  throw new Error("missing txt extraction");
}
if (!result.text.includes("Hello World")) {
  throw new Error("missing docx extraction");
}
if (result.extractedPaths.length !== 2) {
  throw new Error("expected two extracted paths");
}

console.log("test-document-translator: ok");
