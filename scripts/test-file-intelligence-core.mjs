#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  extractPath,
  inspectPath,
  samplePath,
} = require("../src/main/mcp/file-intelligence-core.js");
const { createFileIntelligenceMcpServer } = require("../src/main/mcp/file-intelligence-mcp.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-intel-"));

try {
  assert.equal(inspectPath({}).error, "PATH_REQUIRED", "empty inspect paths are rejected explicitly");
  const largeText = path.join(tmp, "large.log");
  fs.writeFileSync(
    largeText,
    Array.from({ length: 30 }, (_, i) => `line ${i + 1}: ${i % 2 ? "beta" : "alpha"}`).join("\n"),
  );

  const inspected = inspectPath({ path: largeText }, { largeThresholdBytes: 16 });
  assert.equal(inspected.ok, true, "inspect succeeds for text file");
  assert.equal(inspected.kind, "text", "text-like file detected");
  assert.equal(inspected.large, true, "large threshold marks file large");
  assert.equal(inspected.lineCount, 30, "line count is reported");
  assert(!("text" in inspected), "inspect does not return file contents");
  assert(inspected.recommendedActions.includes("sample"), "inspect recommends sampling");

  const sampled = samplePath({ path: largeText, strategy: "head", lines: 3 });
  assert.equal(sampled.ok, true, "sample succeeds");
  assert.equal(sampled.coverage, "sampled", "sample coverage is explicit");
  assert.equal(sampled.rangeType, "lines", "sample records line ranges");
  assert.equal(sampled.rangeStart, 1, "head sample starts at line 1");
  assert.equal(sampled.rangeEnd, 3, "head sample ends at requested line");
  assert.match(sampled.text, /line 1/, "sample contains requested lines");
  assert(!sampled.text.includes("line 30"), "sample does not pretend to include all lines");

  const refused = extractPath({ path: largeText }, { largeThresholdBytes: 16 });
  assert.equal(refused.ok, false, "large extraction without range is refused");
  assert.equal(refused.error, "RANGE_REQUIRED", "refusal explains range is required");
  assert.equal(refused.coverage, "failed", "refusal coverage is failed, not full");

  const extracted = extractPath({
    path: largeText,
    range: { type: "lines", start: 10, end: 12 },
  }, { largeThresholdBytes: 16 });
  assert.equal(extracted.ok, true, "explicit line range extracts");
  assert.equal(extracted.coverage, "partial", "range extraction is partial");
  assert.equal(extracted.rangeStart, 10);
  assert.equal(extracted.rangeEnd, 12);
  assert.match(extracted.text, /line 10/, "range includes start line");
  assert.match(extracted.text, /line 12/, "range includes end line");
  assert(!extracted.text.includes("line 9"), "range excludes previous line");

  const dir = path.join(tmp, "docs");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.writeFileSync(path.join(dir, "b.csv"), "x,y\n1,2\n");
  const dirInfo = inspectPath({ path: dir }, { maxDirectoryEntries: 1 });
  assert.equal(dirInfo.ok, true, "directory inspect succeeds");
  assert.equal(dirInfo.kind, "directory");
  assert.equal(dirInfo.entryCount, 2, "directory entry count reported");
  assert.equal(dirInfo.coverage, "sampled", "directory manifest is bounded/sample-like");
  assert.equal(dirInfo.entries.length, 1, "directory entries are bounded");

  const binary = path.join(tmp, "blob.bin");
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3, 0, 4]));
  const binaryInfo = inspectPath({ path: binary });
  assert.equal(binaryInfo.ok, true, "binary inspect still succeeds with metadata");
  assert.equal(binaryInfo.kind, "binary");
  const binarySample = samplePath({ path: binary });
  assert.equal(binarySample.ok, false, "binary sample fails open");
  assert.equal(binarySample.error, "UNSUPPORTED_BINARY");
  assert.equal(binarySample.coverage, "failed");

  const png = path.join(tmp, "image.png");
  fs.writeFileSync(png, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x03,
    0x00, 0x00, 0x00, 0x02,
    0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]));
  const pngInfo = inspectPath({ path: png });
  assert.equal(pngInfo.ok, true, "image inspect succeeds");
  assert.equal(pngInfo.kind, "image", "image kind is preserved");
  assert.deepEqual(pngInfo.image, { format: "png", width: 3, height: 2 }, "PNG dimensions are read from metadata");
  assert.equal(pngInfo.indexPolicy, "metadata-only", "image inspect does not force content indexing");
  assert(pngInfo.requiredPacks.includes("opencv"), "image enhancement should route to OpenCV pack");
  assert(pngInfo.requiredPacks.includes("rapidocr"), "image OCR should route to RapidOCR pack");
  assert(!pngInfo.recommendedActions.includes("extract"), "non-text files do not recommend text extraction");
  assert(pngInfo.recommendedActions.includes("sample-metadata"), "non-text files recommend metadata-only handling");

  const pdf = path.join(tmp, "file.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
  const pdfInfo = inspectPath({ path: pdf });
  assert.equal(pdfInfo.kind, "pdf", "PDF kind is detected");
  assert.equal(pdfInfo.indexPolicy, "page-index", "PDF should route to page-level indexing");
  assert(pdfInfo.requiredPacks.includes("large-document"), "PDF large-document path should be available");
  assert(pdfInfo.requiredPacks.includes("pro-pdf"), "complex PDF path should route to pro-pdf");
  assert(!pdfInfo.recommendedActions.includes("extract"), "PDF does not get a generic text extraction recommendation from Phase 1/2");

  const xlsx = path.join(tmp, "book.xlsx");
  fs.writeFileSync(xlsx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  const xlsxInfo = inspectPath({ path: xlsx });
  assert.equal(xlsxInfo.kind, "spreadsheet", "spreadsheet kind is detected");
  assert.equal(xlsxInfo.indexPolicy, "sheet-index", "Excel should route to sheet-level indexing");
  assert(xlsxInfo.requiredPacks.includes("large-document"), "large spreadsheet handling should route to large-document pack");
  assert(!xlsxInfo.recommendedActions.includes("extract"), "Excel should not recommend generic full extraction");

  const docx = path.join(tmp, "report.docx");
  fs.writeFileSync(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  assert.equal(inspectPath({ path: docx }).kind, "document", "ZIP-based Office formats outrank generic archive magic");

  const video = path.join(tmp, "clip.mp4");
  fs.writeFileSync(video, Buffer.from("fake mp4"));
  const videoInfo = inspectPath({ path: video });
  assert.equal(videoInfo.kind, "video", "video kind is detected");
  assert.equal(videoInfo.indexPolicy, "media-probe", "video should route to media probing");
  assert(videoInfo.requiredPacks.includes("ffmpeg"), "video probing should route to FFmpeg pack");
  assert(!videoInfo.recommendedActions.includes("extract"), "video should not recommend text extraction");

  const archive = path.join(tmp, "bundle.tar.gz");
  fs.writeFileSync(archive, Buffer.from("not a real archive"));
  const archiveInfo = inspectPath({ path: archive });
  assert.equal(archiveInfo.kind, "archive", "compound archive extensions are detected");
  assert.equal(archiveInfo.indexPolicy, "archive-manifest", "archives route to manifest-first local indexing");
  assert(archiveInfo.recommendedActions.includes("list-archive"), "archives recommend bounded listing");
  assert(!archiveInfo.requiredPacks?.length, "bundled archive support is not presented as an optional runtime pack");

  const disguisedArchive = path.join(tmp, "bundle.payload");
  fs.writeFileSync(disguisedArchive, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  const disguisedArchiveInfo = inspectPath({ path: disguisedArchive });
  assert.equal(disguisedArchiveInfo.kind, "archive", "archive signatures are detected when extensions are missing or misleading");

  const disguisedImageArchive = path.join(tmp, "bundle.png");
  fs.writeFileSync(disguisedImageArchive, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  assert.equal(
    inspectPath({ path: disguisedImageArchive }).kind,
    "archive",
    "archive signatures outrank misleading image extensions",
  );

  const server = createFileIntelligenceMcpServer();
  assert.equal(typeof server.connect, "function", "MCP server constructs with tool schemas");

  console.log("file-intelligence-core: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
