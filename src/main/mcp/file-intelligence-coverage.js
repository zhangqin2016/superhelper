"use strict";

/**
 * What an index covered, and what it only partly covered.
 *
 * A file bigger than the read cap used to yield no evidence at all, and the
 * reason given could not tell "too large" from "binary" — so a caller could not
 * even be told to split the file. Coverage is now something the index reports
 * rather than something the caller has to infer. Acceptance 2026-09-17 DEF-02.
 *
 * [gate: large-text-index-coverage]
 */

/** The `skipped` entry for a file whose text could not be read at all. */
function skippedEntry(sourcePath, read = {}) {
  return {
    sourcePath,
    reason: read.reason === "binary_content" ? "binary_content" : (read.reason || "unreadable"),
    ...(read.byteSize ? { byteSize: read.byteSize } : {}),
  };
}

/**
 * Record that only the head of a file was indexed: mark its chunks as sampled
 * and return the entry that says how much was covered and what to do about it.
 */
function noteTruncatedSource(sourcePath, read = {}, chunks = []) {
  for (const chunk of chunks) chunk.coverage = "sampled";
  return {
    sourcePath,
    bytesIndexed: read.bytesRead,
    byteSize: read.byteSize,
    reason: `indexed the first ${read.bytesRead} of ${read.byteSize} bytes; `
      + "split the file or raise maxFileBytes for full coverage",
  };
}

module.exports = { noteTruncatedSource, skippedEntry };
