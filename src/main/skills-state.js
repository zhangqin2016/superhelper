"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT, userDataPath, agentConfigDir } = require("./config");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("./runtime-node");
const { copyDirRecursiveShipSafe } = require("./ship-ignore");
const MANDATORY_PLATFORM_SKILL_IDS = [
  "lily-workbench-rules",
  "lily-intent-router",
  "lily-context-rules",
  "lily-task-execution-rules",
];

const BUNDLED_SKILL_IDS = [
  "lily-workbench-rules",
  "lily-intent-router",
  "lily-context-rules",
  "lily-task-execution-rules",
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
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
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

function loadManifestFromDir(skillDir) {
  const manifestPath = path.join(skillDir, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const raw = readJsonFile(manifestPath);
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
  const replacements = {
    "{{NODE_BIN}}": nodeBin,
    "{{SKILL_DIR}}": skillDir,
    "{{USER_DATA}}": userDataPath(),
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
  fs.writeFileSync(skillsStatePath(), JSON.stringify(state, null, 2), "utf8");
}

function ensureSkillsStateDefaults() {
  const state = loadSkillsState();
  let changed = false;
  for (const skillId of BUNDLED_SKILL_IDS) {
    const manifest = readBundledManifest(skillId);
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
