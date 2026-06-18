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
const SUPPORTED_KINDS = new Set(["lily-workspace-pack", "lily-workspace-app"]);
const FILES_PREFIX = "files/";
const SKILLS_PREFIX = "skills/";
const CONVENTIONS_ENTRY = "conventions.md";
const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;

// Exclude noise + personal deliverables + secret files — NOT the program.
// dist/build ARE kept (build artifacts are part of running the program, so a
// shared workspace opens the same as the author's). output/ is still excluded:
// it holds personal deliverables (reports, generated files) that don't affect
// how the program runs, and may be private. node_modules is regenerable (npm
// install). Secrets are excluded by filename here + flagged by a content scan
// in the export preview so the author can scrub before sharing.
const EXCLUDED_DIRS = new Set([
  "output", ".lily-work", ".git", "node_modules", "__pycache__",
  ".venv", "venv", ".DS_Store",
]);
const EXCLUDED_FILE_RE =
  /(^\.env|\.(key|pem|p12|pfx|crt|cer|keystore|jks)$|^\.npmrc$|^\.netrc$|^id_rsa|^\.git-credentials$|\.DS_Store$)/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_FILES = 5000;

// Content secret scan: flag (don't auto-strip) likely secrets baked into shared
// files (e.g. a hardcoded key in config.js), so the author can scrub before
// sharing. High-signal patterns only, to keep false positives low.
const SECRET_PATTERNS = [
  [/sk-(?:ant-)?[A-Za-z0-9_-]{16,}/, "API key (sk-)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/, "Google API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bBearer\s+[A-Za-z0-9_\-.]{20,}/, "bearer token"],
  [/\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["'][^"']{12,}["']/i, "key/secret value"],
];
const SCANNABLE_EXT = new Set([
  ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".vue", ".json", ".py", ".txt",
  ".md", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".sh", ".html",
  ".xml", ".properties", ".java", ".go", ".rb", ".php", ".env",
]);
const SECRET_SCAN_MAX_BYTES = 512 * 1024;

// Env templates carry the config *shape* (which vars to set), not real
// secrets — keep them so the recipient can actually run the shared source.
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/i;

function isExcluded(relPath) {
  const segments = relPath.split(/[\\/]/);
  if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  const name = segments[segments.length - 1] || "";
  if (ENV_TEMPLATE_RE.test(name)) return false;
  return EXCLUDED_FILE_RE.test(name);
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

function listSkillFiles(skillDir) {
  const files = listShareableFiles(skillDir);
  return files.filter((file) => file.relPath !== "skill.export.json");
}

function normalizeWorkspaceSkillExport(skill) {
  const id = String(skill?.id || skill?.manifest?.id || "").trim();
  const dir = String(skill?.dir || "").trim();
  if (!SKILL_ID_RE.test(id) || !dir || !fs.existsSync(dir)) return null;
  const manifestPath = path.join(dir, "skill.manifest.json");
  const skillMdPath = path.join(dir, "SKILL.md");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(skillMdPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (String(manifest?.id || "") !== id) return null;
  return {
    id,
    dir,
    enabled: skill?.enabled !== false,
    manifest: {
      ...manifest,
      id,
      origin: manifest.origin || "workspace",
      workspaceOnly: true,
      publisher: manifest.publisher || "Workspace",
    },
  };
}

/**
 * Scan the (already filtered) shareable files for secrets baked into content
 * the pack would carry. Returns [{ relPath, kinds }] — advisory only; the
 * author decides whether to scrub and re-export.
 */
function scanForSecrets(files) {
  const warnings = [];
  for (const file of files) {
    if (file.size > SECRET_SCAN_MAX_BYTES) continue;
    const base = path.basename(file.relPath).toLowerCase();
    const ext = path.extname(base);
    if (!SCANNABLE_EXT.has(ext) && !base.startsWith(".env")) continue;
    let text;
    try {
      text = fs.readFileSync(file.fullPath, "utf8");
    } catch {
      continue;
    }
    const kinds = new Set();
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) kinds.add(label);
    }
    if (kinds.size) warnings.push({ relPath: file.relPath, kinds: [...kinds] });
  }
  return warnings;
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
    secretWarnings: scanForSecrets(files),
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
 * @param {{ id: string, dir: string, manifest?: object, enabled?: boolean }[]} [opts.workspaceSkills]
 * @param {string} opts.exportedAt ISO timestamp (passed in — main owns time)
 * @returns {Promise<Buffer>} zip bytes
 */
async function exportWorkspacePack({ rootPath, name, description, conventions, requiredSkills, workspaceSkills, exportedAt }) {
  if (!rootPath || !fs.existsSync(rootPath)) throw new Error("WORKSPACE_NOT_FOUND");
  const zip = new JSZip();
  const files = listShareableFiles(rootPath);
  for (const file of files) {
    zip.file(`${FILES_PREFIX}${file.relPath}`, fs.readFileSync(file.fullPath));
  }
  const conv = String(conventions || "").trim();
  if (conv) zip.file(CONVENTIONS_ENTRY, conv);

  const exportedWorkspaceSkills = [];
  for (const rawSkill of Array.isArray(workspaceSkills) ? workspaceSkills : []) {
    const skill = normalizeWorkspaceSkillExport(rawSkill);
    if (!skill) continue;
    const skillFiles = listSkillFiles(skill.dir);
    if (!skillFiles.some((file) => file.relPath === "SKILL.md")) continue;
    if (!skillFiles.some((file) => file.relPath === "skill.manifest.json")) continue;
    for (const file of skillFiles) {
      if (file.relPath === "skill.manifest.json") {
        zip.file(`${SKILLS_PREFIX}${skill.id}/${file.relPath}`, `${JSON.stringify(skill.manifest, null, 2)}\n`);
      } else {
        zip.file(`${SKILLS_PREFIX}${skill.id}/${file.relPath}`, fs.readFileSync(file.fullPath));
      }
    }
    exportedWorkspaceSkills.push({
      id: skill.id,
      name: String(skill.manifest.name || skill.id),
      version: String(skill.manifest.version || "0.1.0"),
      enabled: skill.enabled,
      workspaceOnly: true,
    });
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "lily-workspace-pack",
    name: String(name || "workspace"),
    description: String(description || ""),
    exportedAt: String(exportedAt || ""),
    fileCount: files.length,
    hasConventions: Boolean(conv),
    requiredSkills: Array.isArray(requiredSkills) ? requiredSkills.filter(Boolean) : [],
    workspaceSkills: exportedWorkspaceSkills,
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
  if (!SUPPORTED_KINDS.has(manifest?.kind) || !Number.isInteger(manifest.schemaVersion)) {
    throw new Error("NOT_A_WORKSPACE_PACK");
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error("PACK_TOO_NEW");
  return { zip, manifest };
}

function manifestWorkspaceSkillIds(manifest) {
  return (Array.isArray(manifest?.workspaceSkills) ? manifest.workspaceSkills : [])
    .map((skill) => String(skill?.id || "").trim())
    .filter((id) => SKILL_ID_RE.test(id));
}

async function importWorkspaceSkills(zip, manifest, targetDir) {
  const ids = new Set(manifestWorkspaceSkillIds(manifest));
  const imported = [];
  if (!ids.size) return imported;

  const root = path.join(targetDir, ".lily-work", "imported-skills");
  const byId = new Map();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith(SKILLS_PREFIX)) continue;
    const rest = entry.name.slice(SKILLS_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const skillId = rest.slice(0, slash);
    if (!ids.has(skillId)) continue;
    const rel = rest.slice(slash + 1);
    if (!rel) continue;
    const dest = safeJoin(path.join(root, skillId), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.async("nodebuffer"));
    byId.set(skillId, path.join(root, skillId));
  }

  for (const skillId of ids) {
    const dir = byId.get(skillId);
    if (!dir) continue;
    const manifestPath = path.join(dir, "skill.manifest.json");
    const skillMdPath = path.join(dir, "SKILL.md");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(skillMdPath)) continue;
    let skillManifest;
    try {
      skillManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (String(skillManifest?.id || "") !== skillId) continue;
    const manifestEntry = (manifest.workspaceSkills || []).find((skill) => skill?.id === skillId) || {};
    imported.push({
      id: skillId,
      dir,
      enabled: manifestEntry.enabled !== false,
      manifest: {
        ...skillManifest,
        id: skillId,
        origin: skillManifest.origin || "workspace",
        workspaceOnly: true,
        publisher: skillManifest.publisher || "Workspace",
      },
    });
  }
  return imported;
}

/**
 * Extract a pack's files into targetDir (must be empty/new). Returns manifest,
 * conventions text (caller re-maps it to the new project id), and embedded
 * workspace skills restored into a temporary import area.
 * @returns {Promise<{ manifest: object, conventions: string, workspaceSkills: object[] }>}
 */
async function importWorkspacePack(zipBuffer, targetDir) {
  const { zip, manifest } = await readPackManifest(zipBuffer);
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = Object.values(zip.files).filter((e) => !e.dir && e.name.startsWith(FILES_PREFIX));
  const declaredWorkspaceSkillIds = manifestWorkspaceSkillIds(manifest);
  if (entries.length === 0 && declaredWorkspaceSkillIds.length === 0) {
    throw new Error("WORKSPACE_PACK_EMPTY");
  }
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
  const workspaceSkills = await importWorkspaceSkills(zip, manifest, targetDir);

  return { manifest, conventions, workspaceSkills };
}

module.exports = {
  MANIFEST_NAME,
  SCHEMA_VERSION,
  SUPPORTED_KINDS,
  SKILLS_PREFIX,
  EXCLUDED_DIRS,
  isExcluded,
  listShareableFiles,
  listSkillFiles,
  scanForSecrets,
  previewExport,
  exportWorkspacePack,
  readPackManifest,
  importWorkspacePack,
  safeJoin,
};
