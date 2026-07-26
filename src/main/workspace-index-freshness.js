"use strict";

// Freshness guard for workspace knowledge-index retrieval.
//
// INVARIANT: the index is a POINTER/CACHE; the filesystem is TRUTH. A file that
// was indexed then DELETED (or an index that outlived its files) must never be
// cited as if it still exists — that's the "confidently wrong about deleted
// content" failure that would make the platform dumber than having no index.
//
// So every retrieved match is verified against the live filesystem: a match whose
// local source file is DEFINITIVELY gone is dropped (and reported for eviction).
// FAIL-OPEN: anything ambiguous (URL/synthetic source, unreadable path, fs error)
// is KEPT — downstream grounding re-reads the live file anyway, so the floor is
// "read current files", never "fabricate from stale chunks".

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Only local filesystem paths are verifiable. URLs / synthetic sources are not
// (and must be kept — we can't prove them stale).
function looksLikeLocalPath(sourcePath) {
  const sp = String(sourcePath || "").trim();
  if (!sp) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(sp)) return false; // http://, https://, data:, etc.
  return true;
}

function resolveSource(sourcePath, workspacePath) {
  const sp = String(sourcePath || "");
  if (path.isAbsolute(sp)) return sp;
  return path.join(String(workspacePath || ""), sp);
}

function fileContentHash(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

// true = current, false = DEFINITIVELY stale/gone, null = can't tell (keep).
function sourceIsCurrent(sourcePath, workspacePath, expectedStamp = null) {
  if (!looksLikeLocalPath(sourcePath)) return null;
  const resolved = resolveSource(sourcePath, workspacePath);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
    if (expectedStamp && typeof expectedStamp === "object") {
      const expectedSize = Number(expectedStamp.size || 0);
      const expectedMtime = Number(expectedStamp.mtimeMs || 0);
      if (expectedSize > 0 && Number(stat.size) !== expectedSize) return false;
      if (expectedMtime > 0 && Math.floor(stat.mtimeMs) !== Math.floor(expectedMtime)) return false;
      const expectedHash = String(expectedStamp.contentHash || "");
      if (expectedHash && fileContentHash(resolved) !== expectedHash) return false;
    }
    return true;
  } catch (err) {
    // Only a confirmed "not found" means the file is gone. Any OTHER error
    // (permission, transient, EMFILE) is ambiguous → keep, never wrongfully
    // evict (existsSync would have returned false and destroyed real chunks).
    if (err && err.code === "ENOENT") return false;
    return null;
  }
}

function sourceIsPresent(sourcePath, workspacePath) {
  return sourceIsCurrent(sourcePath, workspacePath, null);
}

// Partition query matches into { fresh, stalePaths }. Only matches whose local
// source file is definitively absent or differs from its indexed fingerprint go
// stale; everything ambiguous stays fresh (fail open).
function partitionMatchesByFreshness(matches = [], { workspacePath = "", sourceStamps = null } = {}) {
  const fresh = [];
  const stalePaths = new Set();
  const currentBySource = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const sourcePath = String(match?.sourcePath || "");
    const expectedStamp = sourceStamps instanceof Map
      ? sourceStamps.get(sourcePath)
      : null;
    if (!currentBySource.has(sourcePath)) {
      currentBySource.set(sourcePath, sourceIsCurrent(sourcePath, workspacePath, expectedStamp));
    }
    const present = currentBySource.get(sourcePath);
    if (present === false) {
      stalePaths.add(sourcePath);
      continue;
    }
    fresh.push(match);
  }
  return { fresh, stalePaths: [...stalePaths] };
}

module.exports = {
  looksLikeLocalPath,
  resolveSource,
  sourceIsCurrent,
  sourceIsPresent,
  partitionMatchesByFreshness,
};
