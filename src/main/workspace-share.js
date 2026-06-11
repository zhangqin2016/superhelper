"use strict";

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

/**
 * Workspace capability packs (.lilyspace.zip): export a workspace as a
 * shareable, self-describing bundle and import it back. A pack carries the
 * three places a workspace's capability actually lives:
 *   1. workspace files (knowledge bases, scripts, templates, .cursorrules…)
 *   2. learned conventions (L1 — stored app-side, re-mapped on import)
 *   3. a declaration of required skills (skills live globally, not in the
 *      folder — the importer reconciles against what's installed)
 *
 * Privacy is positional, never claimed-magic: directories that typically hold
 * personal output are excluded by default and the caller previews the file
 * list before exporting. Import is hardened against zip-slip.
 */

const MANIFEST_NAME = "lily-workspace.json";
const SCHEMA_VERSION = 1;
const FILES_PREFIX = "files/";
const CONVENTIONS_ENTRY = "conventions.md";

// Positional privacy + noise exclusions. output/ holds personal deliverables
// (e.g. someone's birth-chart report); .lily-work is scratch.
const EXCLUDED_DIRS = new Set([
  "output", ".lily-work", ".git", "node_modules", "__pycache__",
  ".venv", "venv", "dist", "build", ".DS_Store",
]);
const EXCLUDED_FILE_RE = /(^\.env|\.(key|pem|p12|pfx)$|\.DS_Store$)/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_FILES = 5000;

function isExcluded(relPath) {
  const segments = relPath.split(/[\\/]/);
  if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  return EXCLUDED_FILE_RE.test(segments[segments.length - 1] || "");
}

/** Walk the workspace, honoring exclusions, returning {relPath, size}. */
function listShareableFiles(rootPath) {
  const out = [];
  const walk = (dir, rel) => {
    if (out.length > MAX_TOTAL_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcluded(childRel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, childRel);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) continue;
        out.push({ relPath: childRel, fullPath: full, size });
      }
    }
  };
  walk(rootPath, "");
  return out;
}

/**
 * Preview what an export would contain — shown to the user before they
 * commit, so privacy is an informed choice, not a silent promise.
 */
function previewExport(rootPath) {
  const files = listShareableFiles(rootPath);
  const byTopDir = new Map();
  for (const file of files) {
    const top = file.relPath.split("/")[0];
    const key = file.relPath.includes("/") ? `${top}/` : top;
    byTopDir.set(key, (byTopDir.get(key) || 0) + 1);
  }
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    groups: [...byTopDir.entries()].map(([name, count]) => ({ name, count })),
    excludedDirs: [...EXCLUDED_DIRS],
  };
}

/**
 * @param {object} opts
 * @param {string} opts.rootPath workspace dir
 * @param {string} opts.name display name
 * @param {string} [opts.description]
 * @param {string} [opts.conventions] learned-conventions text
 * @param {string[]} [opts.requiredSkills] skill ids the workspace relies on
 * @param {string} opts.exportedAt ISO timestamp (passed in — main owns time)
 * @returns {Promise<Buffer>} zip bytes
 */
async function exportWorkspacePack({ rootPath, name, description, conventions, requiredSkills, exportedAt }) {
  if (!rootPath || !fs.existsSync(rootPath)) throw new Error("WORKSPACE_NOT_FOUND");
  const zip = new JSZip();
  const files = listShareableFiles(rootPath);
  for (const file of files) {
    zip.file(`${FILES_PREFIX}${file.relPath}`, fs.readFileSync(file.fullPath));
  }
  const conv = String(conventions || "").trim();
  if (conv) zip.file(CONVENTIONS_ENTRY, conv);

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "lily-workspace-pack",
    name: String(name || "workspace"),
    description: String(description || ""),
    exportedAt: String(exportedAt || ""),
    fileCount: files.length,
    hasConventions: Boolean(conv),
    requiredSkills: Array.isArray(requiredSkills) ? requiredSkills.filter(Boolean) : [],
  };
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** zip-slip guard: a resolved entry path must stay inside the target dir. */
function safeJoin(targetDir, relPath) {
  const resolved = path.resolve(targetDir, relPath);
  const base = path.resolve(targetDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`UNSAFE_PATH: ${relPath}`);
  }
  return resolved;
}

async function readPackManifest(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const entry = zip.file(MANIFEST_NAME);
  if (!entry) throw new Error("NOT_A_WORKSPACE_PACK");
  let manifest;
  try {
    manifest = JSON.parse(await entry.async("string"));
  } catch {
    throw new Error("MANIFEST_CORRUPT");
  }
  if (manifest?.kind !== "lily-workspace-pack" || !Number.isInteger(manifest.schemaVersion)) {
    throw new Error("NOT_A_WORKSPACE_PACK");
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error("PACK_TOO_NEW");
  return { zip, manifest };
}

/**
 * Extract a pack's files into targetDir (must be empty/new). Returns manifest
 * plus the conventions text (caller re-maps it to the new project id).
 * @returns {Promise<{ manifest: object, conventions: string }>}
 */
async function importWorkspacePack(zipBuffer, targetDir) {
  const { zip, manifest } = await readPackManifest(zipBuffer);
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = Object.values(zip.files).filter((e) => !e.dir && e.name.startsWith(FILES_PREFIX));
  for (const entry of entries) {
    const rel = entry.name.slice(FILES_PREFIX.length);
    if (!rel) continue;
    const dest = safeJoin(targetDir, rel); // throws on zip-slip
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.async("nodebuffer"));
  }

  let conventions = "";
  const convEntry = zip.file(CONVENTIONS_ENTRY);
  if (convEntry) conventions = await convEntry.async("string");

  return { manifest, conventions };
}

module.exports = {
  MANIFEST_NAME,
  SCHEMA_VERSION,
  EXCLUDED_DIRS,
  isExcluded,
  listShareableFiles,
  previewExport,
  exportWorkspacePack,
  readPackManifest,
  importWorkspacePack,
  safeJoin,
};
