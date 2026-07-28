#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const {
  archiveKindForPath,
  detectArchiveFormat,
  listArchive,
  parseSevenZipList,
  readArchiveEntry,
} = require("../src/main/mcp/archive-intelligence.js");
const { indexPath, queryIndex } = require("../src/main/mcp/file-intelligence-index.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-archive-intel-"));

try {
  assert.equal(archiveKindForPath("bundle.tar.gz"), "archive");
  assert.equal(archiveKindForPath("bundle.TGZ"), "archive");
  assert.equal(archiveKindForPath("bundle.rar"), "archive");
  assert.equal(archiveKindForPath("notes.txt"), "");
  assert.equal(listArchive({}).error, "PATH_REQUIRED");

  const parsed = parseSevenZipList([
    "Path = safe/readme.txt",
    "Size = 12",
    "Packed Size = 8",
    "Attributes = A",
    "Encrypted = -",
    "",
    "Path = ../escape.txt",
    "Size = 4",
    "Packed Size = 4",
    "Attributes = A",
    "Encrypted = +",
    "",
  ].join("\n"), { maxEntries: 20 });
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[1].unsafePath, true, "parent traversal is marked unsafe");
  assert.equal(parsed.entries[1].encrypted, true, "encrypted entries are reported");
  assert.equal(
    readArchiveEntry({ path: path.join(tmp, "missing.zip"), entryPath: "@entry-list.txt" }).error,
    "PATH_UNAVAILABLE",
    "path validation does not hide an unavailable archive",
  );

  const zip = new JSZip();
  zip.file("docs/readme.txt", "alpha release notes\nbeta details\n");
  zip.file("docs/data.bin", Buffer.from([1, 2, 3, 4, 5, 6]));
  zip.file("large.txt", "x".repeat(2048));
  const zipPath = path.join(tmp, "customer.zip");
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  const disguisedZipPath = path.join(tmp, "customer.payload");
  fs.copyFileSync(zipPath, disguisedZipPath);
  assert.equal(detectArchiveFormat(disguisedZipPath), "zip", "archive magic is detected without a known extension");

  const listed = listArchive({ path: zipPath, maxEntries: 20 });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.kind, "archive");
  assert(listed.entries.some((entry) => entry.path === "docs/readme.txt"));
  assert.equal(listed.coverage, "full");
  assert.equal(listed.wroteFiles, false, "listing must not extract archive contents");

  const textEntry = readArchiveEntry({ path: zipPath, entryPath: "docs/readme.txt" });
  assert.equal(textEntry.ok, true, JSON.stringify(textEntry));
  assert.match(textEntry.text, /alpha release notes/);
  assert.equal(textEntry.coverage, "full");

  const binaryEntry = readArchiveEntry({ path: zipPath, entryPath: "docs/data.bin" });
  assert.equal(binaryEntry.ok, false);
  assert.equal(binaryEntry.error, "ARCHIVE_ENTRY_BINARY");

  const oversized = readArchiveEntry({
    path: zipPath,
    entryPath: "large.txt",
    maxEntryBytes: 128,
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error, "ARCHIVE_ENTRY_TOO_LARGE");

  const unsafe = readArchiveEntry({ path: zipPath, entryPath: "../escape.txt" });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error, "ARCHIVE_ENTRY_UNSAFE_PATH");
  assert.equal(
    readArchiveEntry({ path: zipPath, entryPath: "@entry-list.txt" }).error,
    "ARCHIVE_ENTRY_UNSAFE_PATH",
    "7-Zip listfile syntax cannot be supplied as an entry name",
  );
  assert.equal(
    readArchiveEntry({ path: zipPath, entryPath: "line\nbreak.txt" }).error,
    "ARCHIVE_ENTRY_UNSAFE_PATH",
    "control characters are refused in archive entry selectors",
  );

  const storeRoot = path.join(tmp, "indexes");
  const indexed = indexPath({ path: zipPath, storeRoot });
  assert.equal(indexed.ok, true, JSON.stringify(indexed));
  const queried = queryIndex({ indexId: indexed.indexId, storeRoot, query: "readme" });
  assert.equal(queried.ok, true);
  assert(queried.matches.some((match) => /docs\/readme\.txt/.test(match.excerpt)));

  const archiveDir = path.join(tmp, "archive-set");
  fs.mkdirSync(archiveDir);
  fs.copyFileSync(zipPath, path.join(archiveDir, "one.zip"));
  fs.copyFileSync(zipPath, path.join(archiveDir, "two.zip"));
  const cappedIndex = indexPath({ path: archiveDir, storeRoot, maxArchives: 1 });
  assert.equal(cappedIndex.ok, true);
  assert.equal(cappedIndex.coverage, "sampled");
  assert(cappedIndex.skipped.some((item) => item.reason === "archive inspection limit reached"));

  console.log("archive-intelligence: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
