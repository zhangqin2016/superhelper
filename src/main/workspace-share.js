"use strict";

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const exportPlanner = require("./workspace-export-planner");
const packCompat = require("./workspace-pack-compat");
const packLimits = require("./workspace-pack-limits");
const taskPortability = require("./scheduled-task-portability");

/**
 * Workspace capability packs (.lilyspace.zip): export a workspace as a
 * shareable, self-describing bundle and import it back. A pack carries the
 * three places a workspace's capability actually lives:
 *   1. workspace files (knowledge bases, scripts, templates, .cursorrules…)
 *   2. learned conventions (L1 — stored app-side, re-mapped on import)
 *   3. a declaration of required skills (skills live globally, not in the
 *      folder — the importer reconciles against what's installed)
 *
 * Export is complete-by-default for user-created workspace content: reports,
 * learned data, templates, scripts, and generated assets should travel unless
 * they are clear dependency/cache noise or secrets. Import is hardened against
 * zip-slip.
 */

const MANIFEST_NAME = "lily-workspace.json";
const WORKSPACE_APP_MANIFEST = "lily-app.json";
const PACK_META_PREFIX = ".lilyspace/";
const PACK_MANIFEST_ENTRY = `${PACK_META_PREFIX}${MANIFEST_NAME}`;
const PACK_CONVENTIONS_ENTRY = `${PACK_META_PREFIX}conventions.md`;
const { AUTOMATIONS_ENTRY } = taskPortability;
const PACK_SKILLS_PREFIX = `${PACK_META_PREFIX}skills/`;
const SCHEMA_VERSION = 1;
const SUPPORTED_KINDS = new Set(["lily-workspace-pack", "lily-workspace-app"]);
const FILES_PREFIX = "files/";
const SKILLS_PREFIX = "skills/";
const CONVENTIONS_ENTRY = "conventions.md";
const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;

// Exclude dependency/cache noise + secret files — NOT the customer's work.
// dist/build ARE kept (build artifacts are part of running the program, so a
// shared workspace opens the same as the author's). output/ is kept because
// Lily itself uses it as the default home for user deliverables; excluding it
// made shared apps feel incomplete. node_modules is regenerable (npm install).
// Secrets are excluded by filename here + flagged by a content scan in the
// export preview so the author can scrub before sharing.
const EXCLUDED_DIRS = new Set([
  ".lilyspace", ".lily-work", ".git", "node_modules", "__pycache__",
  ".venv", "venv", ".DS_Store",
]);
const EXCLUDED_FILE_RE =
  /(^\.env|\.(key|pem|p12|pfx|crt|cer|keystore|jks)$|^\.npmrc$|^\.netrc$|^id_rsa|^\.git-credentials$|\.DS_Store$)/i;
const MAX_FILE_BYTES = exportPlanner.MAX_FILE_BYTES;
const MAX_TOTAL_FILES = exportPlanner.MAX_TOTAL_FILES;
const SKIPPED_SAMPLE_LIMIT = 50;
const LEGACY_MIRROR_MAX_TOTAL_BYTES = Math.floor(MAX_FILE_BYTES / 2);

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
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DOMAIN_RE = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::\d+)?/ig;
const CREDENTIAL_TERM_RE =
  /\b(cookie|cookies|token|refresh[_-]?token|access[_-]?token|authorization|bearer|password|passwd|account|username|login|email|tenant|customer|client|secret|session|credential)\b/ig;

// Env templates carry the config *shape* (which vars to set), not real
// secrets — keep them so the recipient can actually run the shared source.
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/i;

function normalizeRelPath(value) {
  return exportPlanner.normalizeRelPath(value);
}

function isUnderRelPath(relPath, parentPath) {
  return exportPlanner.isUnderRelPath(relPath, parentPath);
}

function normalizeIncludePaths(paths) {
  return exportPlanner.normalizePathList(paths);
}

function isExplicitlyIncluded(relPath, includePaths) {
  return includePaths.some((includePath) => isUnderRelPath(relPath, includePath));
}

function hasExplicitIncludedDescendant(relPath, includePaths) {
  const rel = normalizeRelPath(relPath);
  return Boolean(rel && includePaths.some((includePath) => includePath.startsWith(`${rel}/`)));
}

function isBenignExcludedFile(relPath) {
  return path.basename(String(relPath || "")).toLowerCase() === ".ds_store";
}

function isExcluded(relPath, options = {}) {
  return exportPlanner.isExcluded(relPath, options);
}

/** Walk the workspace, honoring exclusions, returning included files + omissions. */
function collectShareableFiles(rootPath, options = {}) {
  return exportPlanner.planWorkspaceExport(rootPath, options);
}

/** Walk the workspace, honoring exclusions, returning {relPath, size}. */
function listShareableFiles(rootPath, options = {}) {
  return collectShareableFiles(rootPath, options).files;
}

function listSkillFiles(skillDir) {
  const files = listShareableFiles(skillDir);
  return files.filter((file) => file.relPath !== "skill.export.json");
}

function readWorkspaceAppManifest(rootPath) {
  return exportPlanner.readWorkspaceAppManifest(rootPath);
}

function extractDataLocationPaths(value) {
  const text = String(value || "");
  const paths = [];
  for (const match of text.matchAll(/\(([^)]+)\)/g)) {
    for (const part of String(match[1] || "").split(/[,，;；\s]+/)) {
      const rel = normalizeRelPath(part);
      if (rel) paths.push(rel);
    }
  }
  return paths;
}

function workspaceAppDataPaths(manifest) {
  return exportPlanner.workspaceAppExportConfig(manifest).dataPaths;
}

function workspaceAppExportInfo(rootPath) {
  return exportPlanner.workspaceAppExportInfo(rootPath);
}

function summarizeAppDataPaths(files, dataPaths) {
  return normalizeIncludePaths(dataPaths)
    .map((dataPath) => {
      const matched = files.filter((file) => isUnderRelPath(file.relPath, dataPath));
      return {
        path: `${dataPath}/`,
        fileCount: matched.length,
        totalBytes: matched.reduce((sum, file) => sum + file.size, 0),
      };
    });
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

function isWorkspaceLearnedSkill(skill) {
  const manifest = skill?.manifest || {};
  const id = String(skill?.id || "").toLowerCase();
  const text = [
    id,
    manifest.id,
    manifest.name,
    manifest.description,
    manifest.origin,
    manifest.category,
    ...(Array.isArray(manifest.tags) ? manifest.tags : []),
  ].join(" ").toLowerCase();
  return manifest.workspaceOnly === true
    || manifest.origin === "workspace"
    || text.includes("learned")
    || text.includes("web-system")
    || text.includes("oa")
    || text.includes("erp")
    || text.includes("crm")
    || text.includes("admin");
}

function addUniqueWarning(warnings, warning) {
  const key = [
    warning.kind,
    warning.relPath || "",
    warning.label || "",
    warning.value || "",
  ].join("\u0000");
  if (warnings.some((item) => [
    item.kind,
    item.relPath || "",
    item.label || "",
    item.value || "",
  ].join("\u0000") === key)) return;
  warnings.push(warning);
}

function scanWorkspaceSkillRisks(skill, files) {
  const warnings = [];
  if (!isWorkspaceLearnedSkill(skill)) return warnings;

  const skillName = String(skill.manifest?.name || skill.id || "").trim();
  if (skillName && skillName !== String(skill.id || "")) {
    addUniqueWarning(warnings, {
      kind: "workspace-identity",
      label: "workspace/customer-specific skill name",
      value: skillName,
    });
  }

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

    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) {
        addUniqueWarning(warnings, {
          kind: "secret",
          relPath: file.relPath,
          label,
        });
      }
    }

    DOMAIN_RE.lastIndex = 0;
    for (const match of text.matchAll(DOMAIN_RE)) {
      const domain = String(match[1] || "").toLowerCase();
      if (!domain) continue;
      addUniqueWarning(warnings, {
        kind: "domain",
        relPath: file.relPath,
        label: "domain/base URL",
        value: domain,
      });
    }

    CREDENTIAL_TERM_RE.lastIndex = 0;
    for (const match of text.matchAll(CREDENTIAL_TERM_RE)) {
      const term = String(match[1] || "").toLowerCase();
      if (!term) continue;
      addUniqueWarning(warnings, {
        kind: "credential-term",
        relPath: file.relPath,
        label: "credential/account field",
        value: term,
      });
      if (warnings.filter((item) => item.relPath === file.relPath && item.kind === "credential-term").length >= 6) break;
    }
  }

  return warnings.slice(0, 50);
}

function previewWorkspaceSkills(workspaceSkills) {
  const previews = [];
  for (const rawSkill of Array.isArray(workspaceSkills) ? workspaceSkills : []) {
    const skill = normalizeWorkspaceSkillExport(rawSkill);
    if (!skill) continue;
    const files = listSkillFiles(skill.dir);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    previews.push({
      id: skill.id,
      name: String(skill.manifest.name || skill.id),
      version: String(skill.manifest.version || "0.1.0"),
      enabled: skill.enabled,
      workspaceOnly: true,
      fileCount: files.length,
      totalBytes,
      riskWarnings: scanWorkspaceSkillRisks(skill, files),
    });
  }
  return previews;
}

/**
 * Preview what an export would contain — shown to the user before they
 * commit, so privacy is an informed choice, not a silent promise.
 */
function previewExport(rootPath) {
  const collected = collectShareableFiles(rootPath);
  const files = collected.files;
  return {
    fileCount: collected.fileCount,
    totalBytes: collected.totalBytes,
    groups: collected.groups,
    categorySummary: collected.categorySummary,
    secretWarnings: scanForSecrets(files),
    excludedDirs: [...EXCLUDED_DIRS],
    workspaceApp: collected.workspaceApp,
    appDataPaths: collected.appDataPaths,
    skippedFiles: collected.skippedFiles,
    skippedDirs: collected.skippedDirs,
    skippedFileCount: collected.skippedFileCount,
    skippedDirCount: collected.skippedDirCount,
    truncated: collected.truncated,
    limits: collected.limits,
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
async function exportWorkspacePack({ rootPath, name, description, conventions, requiredSkills, workspaceSkills, automationTemplates, exportedAt }) {
  if (!rootPath || !fs.existsSync(rootPath)) throw new Error("WORKSPACE_NOT_FOUND");
  const zip = new JSZip();
  const exportPlan = collectShareableFiles(rootPath);
  const workspaceApp = exportPlan.workspaceApp;
  const files = exportPlan.files;
  const conv = String(conventions || "").trim();
  const automationCount = taskPortability.writeAutomationEntry(zip, automationTemplates);

  const exportedWorkspaceSkills = [];
  const exportedWorkspaceSkillFiles = [];
  for (const rawSkill of Array.isArray(workspaceSkills) ? workspaceSkills : []) {
    const skill = normalizeWorkspaceSkillExport(rawSkill);
    if (!skill) continue;
    const skillFiles = listSkillFiles(skill.dir);
    if (!skillFiles.some((file) => file.relPath === "SKILL.md")) continue;
    if (!skillFiles.some((file) => file.relPath === "skill.manifest.json")) continue;
    for (const file of skillFiles) {
      exportedWorkspaceSkillFiles.push({ skillId: skill.id, file, manifest: skill.manifest });
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
    kind: workspaceApp ? "lily-workspace-app" : "lily-workspace-pack",
    ...(workspaceApp?.appId ? { appId: workspaceApp.appId } : {}),
    name: String(name || "workspace"),
    description: String(description || ""),
    ...(workspaceApp?.version ? { version: workspaceApp.version } : {}),
    ...(workspaceApp?.dataPaths?.length ? { appDataPaths: workspaceApp.dataPaths.map((p) => `${p}/`) } : {}),
    exportedAt: String(exportedAt || ""),
    fileCount: files.length,
    hasConventions: Boolean(conv),
    requiredSkills: [...new Set([
      ...(Array.isArray(requiredSkills) ? requiredSkills : []),
      ...(workspaceApp?.requiredSkills || []),
    ].filter(Boolean))],
    ...(workspaceApp?.requiredRuntimePacks?.length
      ? { requiredRuntimePacks: [...new Set(workspaceApp.requiredRuntimePacks)] }
      : {}),
    ...(workspaceApp?.publisher ? { publisher: workspaceApp.publisher } : {}),
    workspaceSkills: exportedWorkspaceSkills,
    automationCount,
  };

  const addLegacyMirror =
    exportPlan.totalBytes <= LEGACY_MIRROR_MAX_TOTAL_BYTES &&
    !packCompat.hasLegacyMirrorConflict({
      files,
      workspaceSkillFiles: exportedWorkspaceSkillFiles,
      hasConventions: Boolean(conv),
      manifestName: MANIFEST_NAME,
      conventionsEntry: CONVENTIONS_ENTRY,
      filesPrefix: FILES_PREFIX,
      skillsPrefix: SKILLS_PREFIX,
    });
  for (const file of files) {
    const content = fs.readFileSync(file.fullPath);
    if (addLegacyMirror) zip.file(file.relPath, content);
    zip.file(`${FILES_PREFIX}${file.relPath}`, content);
  }
  if (conv) {
    if (addLegacyMirror) zip.file(PACK_CONVENTIONS_ENTRY, conv);
    zip.file(CONVENTIONS_ENTRY, conv);
  }
  for (const item of exportedWorkspaceSkillFiles) {
    const content = item.file.relPath === "skill.manifest.json"
      ? `${JSON.stringify(item.manifest, null, 2)}\n`
      : fs.readFileSync(item.file.fullPath);
    if (addLegacyMirror) zip.file(`${PACK_SKILLS_PREFIX}${item.skillId}/${item.file.relPath}`, content);
    zip.file(`${SKILLS_PREFIX}${item.skillId}/${item.file.relPath}`, content);
  }
  if (addLegacyMirror) zip.file(PACK_MANIFEST_ENTRY, JSON.stringify(manifest, null, 2));
  zip.file(MANIFEST_NAME, JSON.stringify(packCompat.legacyCompatibilityManifest(manifest), null, 2));
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
  const hiddenEntry = zip.file(PACK_MANIFEST_ENTRY);
  const entry = hiddenEntry || zip.file(MANIFEST_NAME);
  if (!entry) throw new Error("NOT_A_WORKSPACE_PACK");
  if (Number(entry?._data?.uncompressedSize || 0) > MAX_MANIFEST_BYTES) {
    throw new Error("MANIFEST_TOO_LARGE");
  }
  const text = await entry.async("string");
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("MANIFEST_TOO_LARGE");
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("MANIFEST_CORRUPT");
  }
  if (!SUPPORTED_KINDS.has(manifest?.kind) || !Number.isInteger(manifest.schemaVersion)) {
    throw new Error("NOT_A_WORKSPACE_PACK");
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error("PACK_TOO_NEW");
  return { zip, manifest, layout: hiddenEntry ? "root" : "legacy" };
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
    if (entry.dir) continue;
    const prefix = entry.name.startsWith(PACK_SKILLS_PREFIX)
      ? PACK_SKILLS_PREFIX
      : entry.name.startsWith(SKILLS_PREFIX)
        ? SKILLS_PREFIX
        : "";
    if (!prefix) continue;
    const rest = entry.name.slice(prefix.length);
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
async function importWorkspacePack(zipBuffer, targetDir, options = {}) {
  const { zip, manifest, layout } = await readPackManifest(zipBuffer);
  packLimits.assertImportArchiveLimits(zip, options);
  fs.mkdirSync(targetDir, { recursive: true });

  const legacyEntries = Object.values(zip.files).filter((e) => !e.dir && e.name.startsWith(FILES_PREFIX));
  const entries = layout === "legacy"
    ? legacyEntries.map((entry) => ({ entry, rel: entry.name.slice(FILES_PREFIX.length) }))
    : Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .filter((entry) => !entry.name.startsWith(PACK_META_PREFIX))
      .filter((entry) => entry.name !== MANIFEST_NAME && entry.name !== CONVENTIONS_ENTRY)
      .filter((entry) => !packCompat.isLegacyFileMirrorEntry(entry.name, zip, FILES_PREFIX))
      .filter((entry) => !packCompat.isLegacySkillMirrorEntry(entry.name, zip, SKILLS_PREFIX, PACK_SKILLS_PREFIX))
      .map((entry) => ({ entry, rel: entry.name }));
  const declaredWorkspaceSkillIds = manifestWorkspaceSkillIds(manifest);
  if (entries.length === 0 && declaredWorkspaceSkillIds.length === 0) {
    throw new Error("WORKSPACE_PACK_EMPTY");
  }
  for (const { entry, rel } of entries) {
    if (!rel) continue;
    const dest = safeJoin(targetDir, rel); // throws on zip-slip
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.async("nodebuffer"));
  }

  let conventions = "";
  const convEntry = zip.file(PACK_CONVENTIONS_ENTRY) || zip.file(CONVENTIONS_ENTRY);
  if (convEntry) conventions = await convEntry.async("string");
  const workspaceSkills = await importWorkspaceSkills(zip, manifest, targetDir);
  const automations = await taskPortability.readAutomationEntry(zip.file(AUTOMATIONS_ENTRY));
  return { manifest, conventions, workspaceSkills, ...automations };
}

module.exports = {
  MANIFEST_NAME,
  PACK_META_PREFIX,
  PACK_MANIFEST_ENTRY,
  PACK_CONVENTIONS_ENTRY,
  AUTOMATIONS_ENTRY,
  PACK_SKILLS_PREFIX,
  SCHEMA_VERSION,
  SUPPORTED_KINDS,
  SKILLS_PREFIX,
  EXCLUDED_DIRS,
  MAX_FILE_BYTES,
  MAX_TOTAL_FILES,
  MAX_IMPORT_FILES: packLimits.MAX_IMPORT_FILES,
  MAX_IMPORT_TOTAL_BYTES: packLimits.MAX_IMPORT_TOTAL_BYTES,
  LEGACY_MIRROR_MAX_TOTAL_BYTES,
  normalizeRelPath,
  isExcluded,
  collectShareableFiles,
  planWorkspaceExport: exportPlanner.planWorkspaceExport,
  listShareableFiles,
  listSkillFiles,
  readWorkspaceAppManifest,
  workspaceAppDataPaths,
  workspaceAppExportInfo,
  scanForSecrets,
  previewWorkspaceSkills,
  previewExport,
  exportWorkspacePack,
  readPackManifest,
  assertImportArchiveLimits: packLimits.assertImportArchiveLimits,
  importWorkspacePack,
  safeJoin,
};
