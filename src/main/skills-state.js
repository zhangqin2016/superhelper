"use strict";

const fs = require("node:fs");
const jsonFile = require("./json-file");
const path = require("node:path");
const { PROJECT_ROOT, userDataPath, agentConfigDir } = require("./config");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("./runtime-node");
const { copyDirRecursiveShipSafe } = require("./ship-ignore");
const MANDATORY_PLATFORM_SKILL_IDS = [
  "lily-workbench-rules",
  "lily-intent-router",
  "lily-context-rules",
  "lily-task-execution-rules",
  "lily-engineering-rules",
];

const BUNDLED_SKILL_IDS = [
  "lily-workbench-rules",
  "lily-intent-router",
  "lily-context-rules",
  "lily-task-execution-rules",
  "lily-engineering-rules",
  "lily-vision",
  "lily-image-generation",
  "lily-diagrams",
  "lily-video-generation",
  "lily-speech-generation",
  "websearch",
  "webfetch",
];

const PROTECTED_BUNDLED_IDS = new Set(BUNDLED_SKILL_IDS);

/** @type {{ schemaVersion: number, skills: Record<string, { id: string, enabled: boolean, source: string, installedVersion?: string, bundledVersion?: string }> } | null} */
let skillsStateCache = null;

function skillsStatePath() {
  return userDataPath("skills-state.json");
}

function bundledResourceCandidates(relativePath) {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    candidates.push(path.join(process.resourcesPath, relativePath));
  }
  candidates.push(path.join(PROJECT_ROOT, relativePath));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function bundledSkillSource(skillId) {
  return bundledResourceCandidates(path.join("resources", "skills", skillId));
}

function installedSkillDir(skillId) {
  return path.join(agentConfigDir(), "skills", skillId);
}

function readJsonFile(filePath) {
  return jsonFile.readJson(filePath, null);
}

function copyDirRecursive(source, target) {
  copyDirRecursiveShipSafe(source, target);
}

function applyPlaceholders(content, replacements) {
  let out = content;
  for (const [from, to] of Object.entries(replacements)) {
    out = out.replaceAll(from, to);
  }
  return out;
}

// Manifest text keyed by path and validated by the file's own identity
// (mtime + size), so a catalog read costs one stat per skill instead of an
// open+read+parse — and a manifest edited on disk is seen on the very next
// read, without any writer having to remember to invalidate anything.
// Measured on a real profile (45 skills): resolving one session's skills read
// 831 files; every session switch re-ran it. Windows pays for each open twice
// (Defender scans on open), which is where a switch turned into seconds.
/** @type {Map<string, { mtimeMs: number, size: number, text: string }>} */
const manifestTextCache = new Map();

function manifestText(manifestPath) {
  let stat;
  try {
    stat = fs.statSync(manifestPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") { manifestTextCache.delete(manifestPath); return null; }
    // A mocked or restricted fs without a usable stat: read the old way, uncached.
    return fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : null;
  }
  const cached = manifestTextCache.get(manifestPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text;
  let text;
  try { text = fs.readFileSync(manifestPath, "utf8"); } catch { manifestTextCache.delete(manifestPath); return null; }
  manifestTextCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

function loadManifestFromDir(skillDir) {
  const text = manifestText(path.join(skillDir, "skill.manifest.json"));
  if (text == null) return null;
  // Every caller gets its own object: a mutation (bundled-skill-sync edits the
  // installed manifest before writing it back) can never leak into the cache.
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || raw.schemaVersion !== 1 || !raw.id) return null;
  return raw;
}

function readBundledManifest(skillId) {
  const source = bundledSkillSource(skillId);
  if (!source) return null;
  return loadManifestFromDir(source);
}

function readInstalledManifest(skillId) {
  return loadManifestFromDir(installedSkillDir(skillId));
}

function buildReplacements(skillDir, manifest) {
  ensureRuntimeNodeShim();
  const nodeBin = resolveRuntimeNodePath();
  const runtimeScriptsDir = bundledResourceCandidates(path.join("resources", "runtime-scripts")) ||
    path.join(PROJECT_ROOT, "resources", "runtime-scripts");
  const replacements = {
    "{{NODE_BIN}}": nodeBin,
    "{{SKILL_DIR}}": skillDir,
    "{{USER_DATA}}": userDataPath(),
    "{{RUNTIME_SCRIPTS_DIR}}": runtimeScriptsDir,
  };
  const custom = manifest?.placeholders;
  if (custom && typeof custom === "object") {
    for (const [key, relPath] of Object.entries(custom)) {
      replacements[key] = path.join(skillDir, relPath);
    }
  }
  return replacements;
}

function loadSkillsState() {
  if (skillsStateCache) return skillsStateCache;
  const filePath = skillsStatePath();
  let parsed = readJsonFile(filePath);
  if (
    !parsed ||
    parsed.schemaVersion !== 1 ||
    !parsed.skills ||
    typeof parsed.skills !== "object" ||
    Array.isArray(parsed.skills)
  ) {
    parsed = { schemaVersion: 1, skills: {} };
  }
  skillsStateCache = parsed;
  return parsed;
}

function saveSkillsState() {
  const state = loadSkillsState();
  const dir = path.dirname(skillsStatePath());
  fs.mkdirSync(dir, { recursive: true });
  jsonFile.writeJson(skillsStatePath(), state);
}

// Bundled skills ship inside the application and cannot change while it runs,
// so their versions are read once per process. The state normalisation below
// still runs on every call — it is in-memory and is what keeps a mandatory
// skill enabled and a bundled entry present whatever the state file said.
/** @type {Map<string, string | null> | null} skillId → bundled version */
let bundledVersions = null;

function bundledVersionOf(skillId) {
  if (!bundledVersions) bundledVersions = new Map();
  if (!bundledVersions.has(skillId)) {
    const manifest = readBundledManifest(skillId);
    bundledVersions.set(skillId, manifest ? { version: manifest.version } : null);
  }
  return bundledVersions.get(skillId);
}

function ensureSkillsStateDefaults() {
  const state = loadSkillsState();
  let changed = false;
  for (const skillId of BUNDLED_SKILL_IDS) {
    const manifest = bundledVersionOf(skillId);
    if (!manifest) continue;
    if (!state.skills[skillId]) {
      state.skills[skillId] = {
        id: skillId,
        enabled: true,
        source: "bundled",
        installedVersion: manifest.version,
        bundledVersion: manifest.version,
      };
      changed = true;
      continue;
    }
    const entry = state.skills[skillId];
    if (entry.bundledVersion !== manifest.version) {
      entry.bundledVersion = manifest.version;
      changed = true;
    }
    if (entry.enabled === undefined) {
      entry.enabled = true;
      changed = true;
    }
    if (MANDATORY_PLATFORM_SKILL_IDS.includes(skillId) && entry.enabled === false) {
      entry.enabled = true;
      changed = true;
    }
    if (!entry.source) {
      entry.source = "bundled";
      changed = true;
    }
  }
  if (changed) saveSkillsState();
}

function isSkillEnabled(skillId) {
  ensureSkillsStateDefaults();
  if (MANDATORY_PLATFORM_SKILL_IDS.includes(skillId)) return true;
  const entry = loadSkillsState().skills[skillId];
  if (!entry) return false;
  return entry.enabled !== false;
}
module.exports = {
  BUNDLED_SKILL_IDS,
  MANDATORY_PLATFORM_SKILL_IDS,
  PROTECTED_BUNDLED_IDS,
  loadSkillsState,
  saveSkillsState,
  ensureSkillsStateDefaults,
  isSkillEnabled,
  readJsonFile,
  readBundledManifest,
  readInstalledManifest,
  loadManifestFromDir,
  installedSkillDir,
  bundledSkillSource,
  skillsStatePath,
  applyPlaceholders,
  buildReplacements,
  copyDirRecursive,
  bundledResourceCandidates,
};
