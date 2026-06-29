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
  fs.writeFileSync(path.join(source, "blob.bin"), Buffer.from([0, 1, 2, 0]));

  const indexed = indexPath({
    path: source,
    storeRoot,
    chunkLineCount: 2,
    maxFiles: 10,
  });
  assert.equal(indexed.ok, true, "indexPath succeeds for mixed directory");
  assert.equal(indexed.coverage, "indexed", "index coverage is explicit");
  assert(indexed.indexId, "index id returned");
  assert.equal(indexed.filesIndexed, 2, "text-like files are indexed");
  assert.equal(indexed.filesSkipped, 1, "unsupported file is skipped without failing the index");
  assert(indexed.chunkCount >= 3, "chunks are written");
  assert(fs.existsSync(indexed.indexPath), "index record is persisted");

  const record = readIndex({ indexId: indexed.indexId, storeRoot });
  assert.equal(record.ok, true, "readIndex finds persisted index");
  assert.equal(record.chunks.length, indexed.chunkCount, "read index preserves chunks");
  assert(record.chunks.every((chunk) => chunk.sourcePath && chunk.rangeType === "lines"), "chunks carry source line metadata");

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

  const missing = queryIndex({ indexId: indexed.indexId, query: "nonexistent phrase", storeRoot });
  assert.equal(missing.ok, true, "no-hit queries are still ok");
  assert.equal(missing.matches.length, 0, "no-hit query returns empty matches");

  const bad = indexPath({ path: path.join(source, "blob.bin"), storeRoot });
  assert.equal(bad.ok, false, "unsupported single binary file does not build fake index");
  assert.equal(bad.coverage, "failed");

  console.log("file-intelligence-index: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
