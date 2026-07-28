#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  indexPath,
  queryIndex,
  readIndex,
} = require("../src/main/mcp/file-intelligence-index.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-index-"));
const storeRoot = path.join(tmp, "store");

try {
  const source = path.join(tmp, "source");
  fs.mkdirSync(source);
  const policy = path.join(source, "policy.md");
  const notes = path.join(source, "notes.log");
  fs.writeFileSync(policy, [
    "# Refund Policy",
    "Customers may request refunds within 30 days.",
    "Escalations require manager approval.",
    "",
    "# Shipping",
    "Shipping delays should be logged with a carrier reference.",
  ].join("\n"));
  fs.writeFileSync(notes, [
    "2026-01-01 login ok",
    "2026-01-02 refund request from customer A",
    "2026-01-03 timeout talking to billing gateway",
  ].join("\n"));
  fs.writeFileSync(path.join(source, "contract.pdf"), "%PDF-1.4\n%%EOF\n");
  fs.writeFileSync(path.join(source, "sales.xlsx"), "metadata-only placeholder");
  fs.writeFileSync(path.join(source, "photo.png"), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]));
  fs.writeFileSync(path.join(source, "demo.mp4"), "media placeholder");
  fs.writeFileSync(path.join(source, "blob.bin"), Buffer.from([0, 1, 2, 0]));

  const progress = [];
  const indexed = indexPath({
    path: source,
    storeRoot,
    chunkLineCount: 2,
    maxFiles: 10,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(indexed.ok, true, "indexPath succeeds for mixed directory");
  assert.equal(indexed.coverage, "indexed", "index coverage is explicit");
  assert(indexed.indexId, "index id returned");
  assert.equal(indexed.filesIndexed, 6, "text-like and metadata-indexable files are indexed");
  assert.equal(indexed.filesSkipped, 1, "unsupported file is skipped without failing the index");
  assert(indexed.chunkCount >= 3, "chunks are written");
  assert(fs.existsSync(indexed.indexPath), "index record is persisted");
  assert(progress.some((event) => event.phase === "started" && event.total === 7), "indexing reports total files before work");
  assert(progress.some((event) => event.phase === "file-indexed" && event.sourcePath.endsWith("demo.mp4")), "indexing reports per-file metadata progress");
  assert(progress.some((event) => event.phase === "file-skipped" && event.sourcePath.endsWith("blob.bin")), "indexing reports skipped files");
  assert(progress.some((event) => event.phase === "done" && event.filesIndexed === 6), "indexing reports done summary");

  const record = readIndex({ indexId: indexed.indexId, storeRoot });
  assert.equal(record.ok, true, "readIndex finds persisted index");
  assert.equal(record.chunks.length, indexed.chunkCount, "read index preserves chunks");
  assert(record.chunks.every((chunk) => chunk.sourcePath), "chunks carry source metadata");
  assert(record.chunks.some((chunk) => chunk.sourceType === "pdf" && chunk.indexPolicy === "page-index"), "PDF metadata chunks preserve page-index routing");
  assert(record.chunks.some((chunk) => chunk.sourceType === "spreadsheet" && chunk.indexPolicy === "sheet-index"), "Excel metadata chunks preserve sheet-index routing");
  assert(record.chunks.some((chunk) => chunk.sourceType === "image" && chunk.indexPolicy === "metadata-only"), "image metadata chunks preserve metadata-only routing");
  assert(record.chunks.some((chunk) => chunk.sourceType === "video" && chunk.indexPolicy === "media-probe"), "video metadata chunks preserve media-probe routing");

  const refund = queryIndex({
    indexId: indexed.indexId,
    query: "refund approval",
    storeRoot,
    limit: 3,
  });
  assert.equal(refund.ok, true, "queryIndex succeeds");
  assert.equal(refund.coverage, "indexed", "query coverage is indexed");
  assert(refund.matches.length >= 1, "query returns matching evidence");
  assert(refund.matches[0].sourcePath.endsWith("policy.md") || refund.matches[0].sourcePath.endsWith("notes.log"), "match cites source path");
  assert(refund.matches[0].rangeStart >= 1, "match cites range start");
  assert(refund.matches[0].rangeEnd >= refund.matches[0].rangeStart, "match cites range end");
  assert(refund.matches[0].excerpt.length <= 500, "query returns compact excerpts");

  const media = queryIndex({
    indexId: indexed.indexId,
    query: "ffmpeg media probe demo",
    storeRoot,
    limit: 3,
  });
  assert.equal(media.ok, true, "metadata query succeeds");
  assert(media.matches.some((match) => match.sourcePath.endsWith("demo.mp4")), "metadata query can find video files by dependency route");

  const missing = queryIndex({ indexId: indexed.indexId, query: "nonexistent phrase", storeRoot });
  assert.equal(missing.ok, true, "no-hit queries are still ok");
  assert.equal(missing.matches.length, 0, "no-hit query returns empty matches");

  const bad = indexPath({ path: path.join(source, "blob.bin"), storeRoot });
  assert.equal(bad.ok, false, "unsupported single binary file does not build fake index");
  assert.equal(bad.coverage, "failed");

  const fallbackIndexId = "idx_sampled_json_fallback";
  fs.writeFileSync(path.join(storeRoot, `${fallbackIndexId}.json`), JSON.stringify({
    schemaVersion: 1,
    indexId: fallbackIndexId,
    sourcePath: source,
    coverage: "sampled",
    chunks: [{
      chunkId: "sampled-1",
      sourcePath: "policy.md",
      sourceType: "text",
      rangeType: "lines",
      rangeStart: 1,
      rangeEnd: 1,
      coverage: "indexed",
      confidence: "exact",
      excerpt: "refund policy",
      text: "refund policy",
      tokens: ["refund", "policy"],
    }],
  }));
  const fallbackQuery = queryIndex({
    indexId: fallbackIndexId,
    query: "refund",
    storeRoot,
  });
  assert.equal(fallbackQuery.ok, true, "JSON fallback query succeeds");
  assert.equal(fallbackQuery.coverage, "sampled", "JSON fallback preserves partial index coverage");

  console.log("file-intelligence-index: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
