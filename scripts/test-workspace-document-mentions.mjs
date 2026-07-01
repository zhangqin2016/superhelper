#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  extractDocumentMentionCandidates,
  resolveMentionedDocumentFiles,
} = require("../src/main/workspace-document-mentions.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-mentions-"));
const nested = path.join(root, "资料");
fs.mkdirSync(nested, { recursive: true });

const pdfName = "张钦_命理全维度分析.pdf";
const pdfPath = path.join(nested, pdfName);
fs.writeFileSync(pdfPath, "%PDF-1.4\n", "utf8");

assert.deepEqual(
  extractDocumentMentionCandidates(`${pdfName}讲的什么`),
  [pdfName],
  "a filename followed by Chinese text should still be detected",
);

const resolved = resolveMentionedDocumentFiles(`${pdfName}讲的什么`, root);
assert.equal(resolved.files.length, 1, "unique mentioned basename should resolve");
assert.equal(resolved.files[0].path, fs.realpathSync(pdfPath));
assert.equal(resolved.files[0].source, "workspace-document-mention");

const spaced = resolveMentionedDocumentFiles(`请分析 ${pdfName}`, root);
assert.equal(spaced.files.length, 1, "space-delimited filename should resolve");

assert.deepEqual(
  resolveMentionedDocumentFiles("分析这个文档", root).files,
  [],
  "ordinary prose without an explicit document extension must not scan",
);

const dupA = path.join(root, "a");
const dupB = path.join(root, "b");
fs.mkdirSync(dupA);
fs.mkdirSync(dupB);
fs.writeFileSync(path.join(dupA, "same.pdf"), "%PDF-1.4\n", "utf8");
fs.writeFileSync(path.join(dupB, "same.pdf"), "%PDF-1.4\n", "utf8");
const ambiguous = resolveMentionedDocumentFiles("same.pdf", root);
assert.equal(ambiguous.files.length, 0, "ambiguous basenames must not auto-select a file");
assert(
  ambiguous.diagnostics.some((item) => item.type === "ambiguous-basename"),
  "ambiguous resolution should be diagnosable",
);

const outside = path.join(os.tmpdir(), `outside-${Date.now()}.pdf`);
fs.writeFileSync(outside, "%PDF-1.4\n", "utf8");
const escaped = resolveMentionedDocumentFiles(path.relative(root, outside), root);
assert.equal(escaped.files.length, 0, "relative traversal outside workspace must be blocked");

console.log("test-workspace-document-mentions: ok");
