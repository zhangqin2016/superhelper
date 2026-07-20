"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { compareSemver } = require("./skill-version");
const {
  BUNDLED_SKILL_IDS,
  PROTECTED_BUNDLED_IDS,
  applyPlaceholders,
  buildReplacements,
  bundledSkillSource,
  copyDirRecursive,
  ensureSkillsStateDefaults,
  installedSkillDir,
  loadManifestFromDir,
  loadSkillsState,
  readBundledManifest,
  readInstalledManifest,
  saveSkillsState,
} = require("./skills-state");

function installSkillFromSource(skillId, { force = false } = {}) {
  const source = bundledSkillSource(skillId);
  const target = installedSkillDir(skillId);
  const manifestPath = path.join(target, "skill.manifest.json");
  if (!source) return { id: skillId, installed: false };
  if (!force && fs.existsSync(manifestPath)) return { id: skillId, installed: true, skillDir: target };
  if (force && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });

  copyDirRecursive(source, target);
  const manifest = loadManifestFromDir(target);
  if (!manifest) return { id: skillId, installed: false };

  const skillMdPath = path.join(target, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const replacements = buildReplacements(target, manifest);
    const skillMd = applyPlaceholders(fs.readFileSync(skillMdPath, "utf8"), replacements);
    fs.writeFileSync(skillMdPath, skillMd, "utf8");
  }

  const state = loadSkillsState();
  const now = new Date().toISOString();
  if (!state.skills[skillId]) {
    state.skills[skillId] = {
      id: skillId,
      enabled: true,
      source: "bundled",
      installedAt: now,
    };
  }
  state.skills[skillId].installedVersion = manifest.version;
  state.skills[skillId].bundledVersion = manifest.version;
  state.skills[skillId].source = "bundled";
  state.skills[skillId].updatedAt = now;
  saveSkillsState();
  return { id: skillId, installed: true, skillDir: target, version: manifest.version };
}

function listRelativeFiles(rootDir) {
  const files = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(rootDir, full));
    }
  }
  walk(rootDir);
  return files.sort();
}

function bundledFileContentForCompare(sourceRoot, targetRoot, relativePath, manifest) {
  const content = fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");
  return relativePath === "SKILL.md"
    ? applyPlaceholders(content, buildReplacements(targetRoot, manifest))
    : content;
}

function shouldRefreshBundledSkill(skillId) {
  if (!PROTECTED_BUNDLED_IDS.has(skillId)) return false;
  const source = bundledSkillSource(skillId);
  const target = installedSkillDir(skillId);
  if (!source || !fs.existsSync(target)) return false;
  const manifest = loadManifestFromDir(source);
  if (!manifest) return false;

  const comparableFiles = (root) => listRelativeFiles(root).filter((file) => file !== "skill.manifest.json");
  const sourceFiles = comparableFiles(source);
  const targetFiles = comparableFiles(target);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) return true;

  for (const relativePath of sourceFiles) {
    const targetPath = path.join(target, relativePath);
    if (!fs.existsSync(targetPath)) return true;
    const targetBuffer = fs.readFileSync(targetPath);
    if (relativePath === "SKILL.md") {
      const expected = bundledFileContentForCompare(source, target, relativePath, manifest);
      if (targetBuffer.toString("utf8") !== expected) return true;
    } else if (!fs.readFileSync(path.join(source, relativePath)).equals(targetBuffer)) {
      return true;
    }
  }
  return false;
}

function syncManifestI18nFromBundled(skillId) {
  const installedPath = path.join(installedSkillDir(skillId), "skill.manifest.json");
  if (!fs.existsSync(installedPath)) return;
  const bundled = readBundledManifest(skillId);
  const installed = readInstalledManifest(skillId);
  if (!bundled || !installed) return;

  let changed = false;
  for (const field of ["name", "description", "guideMd"]) {
    const i18nKey = `${field}_i18n`;
    const bundledI18n = bundled[i18nKey];
    if (!bundledI18n || typeof bundledI18n !== "object") continue;
    const installedI18n = installed[i18nKey];
    if (!installedI18n || typeof installedI18n !== "object" || JSON.stringify(installedI18n) !== JSON.stringify(bundledI18n)) {
      installed[i18nKey] = { ...bundledI18n };
      changed = true;
    }
  }
  if (!changed) return;
  try {
    fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), "utf8");
  } catch {
    // Startup remains fail-open when an installed manifest is not writable.
  }
}

function ensureBundledPresent() {
  ensureSkillsStateDefaults();
  return BUNDLED_SKILL_IDS.map((skillId) => {
    syncManifestI18nFromBundled(skillId);
    const bundledManifest = readBundledManifest(skillId);
    const installedManifest = readInstalledManifest(skillId);
    const needsUpgrade = Boolean(bundledManifest && installedManifest)
      && compareSemver(bundledManifest.version, installedManifest.version) > 0;
    const needsRefresh = Boolean(bundledManifest && installedManifest)
      && shouldRefreshBundledSkill(skillId);
    return installSkillFromSource(skillId, { force: needsUpgrade || needsRefresh });
  });
}

module.exports = {
  ensureBundledPresent,
  installSkillFromSource,
  shouldRefreshBundledSkill,
  syncManifestI18nFromBundled,
};
