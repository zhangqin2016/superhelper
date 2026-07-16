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

// true = file present, false = DEFINITIVELY gone, null = can't tell (keep).
function sourceIsPresent(sourcePath, workspacePath) {
  if (!looksLikeLocalPath(sourcePath)) return null;
  const resolved = resolveSource(sourcePath, workspacePath);
  try {
    return fs.existsSync(resolved) ? true : false;
  } catch {
    return null; // fs error → ambiguous → keep (fail-open)
  }
}

// Partition query matches into { fresh, stalePaths }. Only matches whose local
// source file is DEFINITIVELY absent go stale; everything else stays fresh.
function partitionMatchesByFreshness(matches = [], { workspacePath = "" } = {}) {
  const fresh = [];
  const stalePaths = new Set();
  for (const match of Array.isArray(matches) ? matches : []) {
    const present = sourceIsPresent(match?.sourcePath, workspacePath);
    if (present === false) {
      stalePaths.add(String(match.sourcePath));
      continue;
    }
    fresh.push(match);
  }
  return { fresh, stalePaths: [...stalePaths] };
}

module.exports = {
  looksLikeLocalPath,
  resolveSource,
  sourceIsPresent,
  partitionMatchesByFreshness,
};
