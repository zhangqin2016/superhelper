"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".rtf",
]);

const DEFAULT_IGNORES = new Set([
  ".cache",
  ".git",
  ".github",
  ".lily-work",
  "__pycache__",
  "bundles",
  "build",
  "dist",
  "generated-assets",
  "node_modules",
  "release",
  "release-keys",
]);

const MAX_MENTIONS = 8;
const DEFAULT_MAX_SCANNED_FILES = 10_000;
const DEFAULT_MAX_DEPTH = 8;

const EXTENSION_PATTERN = Array.from(DOCUMENT_EXTENSIONS)
  .map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const MENTION_PATTERN = new RegExp(
  String.raw`(^|[\s"'“”‘’\`(（\[【<《])([^\s"'“”‘’\`<>|?*\r\n]+?\.(${EXTENSION_PATTERN}))`,
  "gi",
);

function realpath(filePath) {
  try {
    return fs.realpathSync.native?.(filePath) || fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isInsideRoot(realRoot, realTarget) {
  if (!realRoot || !realTarget) return false;
  if (realTarget === realRoot) return false;
  const relative = path.relative(realRoot, realTarget);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeMentionPath(value) {
  const text = String(value || "").trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return "";
  return text
    .replace(/^[`"'“”‘’]+/, "")
    .replace(/[`"'“”‘’.,;，。；:：)）\]】>》]+$/u, "");
}

function basenameForMention(mention) {
  return path.basename(String(mention || "").replace(/[\\/]+/g, path.sep));
}

function hasPathSeparator(mention) {
  return /[\\/]/.test(String(mention || ""));
}

function extractDocumentMentionCandidates(text) {
  const value = String(text || "");
  if (!value) return [];
  const out = [];
  const seen = new Set();
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const candidate = normalizeMentionPath(match[2]);
    if (!candidate) continue;
    const ext = path.extname(candidate).toLowerCase();
    if (!DOCUMENT_EXTENSIONS.has(ext)) continue;
    const key = candidate.normalize("NFC");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

function candidateToDirectPath(rootPath, candidate) {
  if (!candidate) return null;
  const normalized = hasPathSeparator(candidate)
    ? candidate.replace(/[\\/]+/g, path.sep)
    : candidate;
  if (path.isAbsolute(normalized)) return normalized;
  if (!hasPathSeparator(candidate)) return null;
  return path.resolve(rootPath, normalized);
}

function resolveDirectCandidate(realRoot, candidatePath) {
  if (!candidatePath || !fs.existsSync(candidatePath)) return null;
  let stat;
  try {
    stat = fs.statSync(candidatePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const ext = path.extname(candidatePath).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) return null;
  const realTarget = realpath(candidatePath);
  if (!isInsideRoot(realRoot, realTarget)) return null;
  return { path: realTarget, stat };
}

function findBasenameMatches(rootPath, basenames, options = {}) {
  const matches = new Map();
  for (const basename of basenames) matches.set(basename, []);
  const maxScannedFiles = Number.isFinite(options.maxScannedFiles)
    ? options.maxScannedFiles
    : DEFAULT_MAX_SCANNED_FILES;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const ignores = options.ignores || DEFAULT_IGNORES;
  let scanned = 0;
  let truncated = false;

  function walk(dir, depth) {
    if (scanned >= maxScannedFiles) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= maxScannedFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignores.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (!matches.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!DOCUMENT_EXTENSIONS.has(ext)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      matches.get(entry.name).push({ path: full, stat });
    }
  }

  walk(rootPath, 0);
  return { matches, scanned, truncated };
}

function fileObjectFromMatch(match) {
  return {
    path: match.path,
    name: path.basename(match.path),
    size: match.stat?.size || undefined,
    isImage: false,
    source: "workspace-document-mention",
  };
}

function resolveMentionedDocumentFiles(text, projectPath, existingFiles = [], options = {}) {
  const diagnostics = [];
  const rootPath = projectPath ? path.resolve(projectPath) : "";
  const realRoot = realpath(rootPath);
  if (!realRoot) return { files: [], diagnostics: [{ type: "no-root" }] };

  const candidates = extractDocumentMentionCandidates(text);
  if (!candidates.length) return { files: [], diagnostics };

  const existingRealPaths = new Set();
  for (const file of existingFiles || []) {
    const rp = file?.path ? realpath(file.path) : null;
    if (rp) existingRealPaths.add(rp);
  }

  const resolved = [];
  const resolvedRealPaths = new Set(existingRealPaths);
  const basenameCandidates = [];

  for (const candidate of candidates) {
    const direct = candidateToDirectPath(realRoot, candidate);
    if (!direct) {
      basenameCandidates.push(candidate);
      continue;
    }
    const match = resolveDirectCandidate(realRoot, direct);
    if (!match) {
      diagnostics.push({ type: "direct-not-found", candidate });
      continue;
    }
    if (resolvedRealPaths.has(match.path)) continue;
    resolvedRealPaths.add(match.path);
    resolved.push(fileObjectFromMatch(match));
  }

  const basenames = Array.from(new Set(basenameCandidates.map(basenameForMention).filter(Boolean)));
  if (basenames.length) {
    const { matches, scanned, truncated } = findBasenameMatches(realRoot, basenames, options);
    if (truncated) diagnostics.push({ type: "search-truncated", scanned });
    for (const basename of basenames) {
      const found = (matches.get(basename) || [])
        .map((match) => {
          const rp = realpath(match.path);
          return rp && isInsideRoot(realRoot, rp) ? { path: rp, stat: match.stat } : null;
        })
        .filter(Boolean);
      if (found.length === 0) {
        diagnostics.push({ type: "basename-not-found", basename });
        continue;
      }
      if (found.length > 1) {
        diagnostics.push({ type: "ambiguous-basename", basename, count: found.length });
        continue;
      }
      const [match] = found;
      if (resolvedRealPaths.has(match.path)) continue;
      resolvedRealPaths.add(match.path);
      resolved.push(fileObjectFromMatch(match));
    }
  }

  return { files: resolved, diagnostics };
}

function mergeMentionedDocumentFiles(files = [], mentionedFiles = []) {
  if (!mentionedFiles.length) return files || [];
  const out = Array.isArray(files) ? [...files] : [];
  const seen = new Set();
  for (const file of out) {
    const rp = file?.path ? realpath(file.path) : null;
    if (rp) seen.add(rp);
  }
  for (const file of mentionedFiles) {
    const rp = file?.path ? realpath(file.path) : null;
    if (!rp || seen.has(rp)) continue;
    seen.add(rp);
    out.push(file);
  }
  return out;
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  extractDocumentMentionCandidates,
  mergeMentionedDocumentFiles,
  resolveMentionedDocumentFiles,
};
