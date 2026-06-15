"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { userDataPath, agentConfigDir } = require("./config");
const { compareSemver, isAppVersionCompatible } = require("./skill-version");
const skillGithubInstaller = require("./skill-github-installer");
const { buildManifestFromSkillMd } = require("./skill-md-convert");
const { findSkillRoot } = require("./skill-root");
const { copyDirRecursiveShipSafe, isShipIgnoredEntry } = require("./ship-ignore");
const { downloadArtifactToFile } = require("./artifact-download");
const {
  PROTECTED_BUNDLED_IDS,
  applyPlaceholders,
  buildReplacements,
  installedSkillDir,
  loadSkillsState,
  readInstalledManifest,
  saveSkillsState,
} = require("./skills-state");

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_SKILLPACK_BYTES = 10 * 1024 * 1024;

function skillsCacheDir() {
  return userDataPath("skills-cache");
}

function skillsBackupDir(skillId, version) {
  return userDataPath("skills-backup", skillId, version);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function downloadToFile(url, destPath) {
  try {
    return await downloadArtifactToFile(url, destPath, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_SKILLPACK_BYTES,
    });
  } catch (error) {
    if (error?.message === "ARTIFACT_TOO_LARGE") {
      throw new Error("SKILLPACK_TOO_LARGE");
    }
    throw error;
  }
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const psZip = zipPath.replace(/'/g, "''");
    const psDest = destDir.replace(/'/g, "''");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDest}' -Force`,
      ],
      { stdio: "pipe" },
    );
  } else {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: "pipe" });
  }
}

function assertPathInside(base, target) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error("ZIP_SLIP");
  }
}

function walkDirSafe(rootDir, callback) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (isShipIgnoredEntry(entry.name, entry.isDirectory())) continue;
    const full = path.join(rootDir, entry.name);
    assertPathInside(rootDir, full);
    callback(entry, full);
    if (entry.isDirectory()) {
      walkDirSafe(full, callback);
    }
  }
}

function findSkillRootInArchive(extractDir) {
  return findSkillRoot(extractDir);
}

function validateManifest(manifest, expectedId) {
  if (!manifest || manifest.schemaVersion !== 1) {
    return { ok: false, error: "INVALID_MANIFEST" };
  }
  if (manifest.id !== expectedId) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "Skill ID does not match the directory" };
  }
  if (manifest.runtime && manifest.runtime !== "node" && manifest.runtime !== "none") {
    return { ok: false, error: "INVALID_MANIFEST", detail: "Only node runtime is supported" };
  }
  if (manifest.minAppVersion && !isAppVersionCompatible(manifest.minAppVersion)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "A newer version of the application is required" };
  }
  return { ok: true, manifest };
}

function normalizeManifestFromRegistry(entry, manifest, skillMd) {
  const base = manifest && typeof manifest === "object"
    ? { ...manifest }
    : buildManifestFromSkillMd({
      skillId: entry.id,
      skillMd,
      version: entry.latestVersion,
    });
  return {
    ...base,
    schemaVersion: 1,
    id: entry.id,
    name: entry.name || base.name || entry.id,
    description: entry.description || base.description || "",
    version: base.version || entry.latestVersion,
    minAppVersion: entry.minAppVersion || base.minAppVersion || "0.1.0",
    category: entry.category || base.category || null,
    categoryLabel: entry.categoryLabel || base.categoryLabel || null,
    publisher: entry.publisher || base.publisher || "Lily Workbench",
    capabilityLayer: entry.capabilityLayer || base.capabilityLayer || "tool",
    riskLevel: entry.riskLevel || base.riskLevel || "low",
    permissions: {
      network: Boolean(base.permissions?.network),
      filesystem: base.permissions?.filesystem || "none",
      subprocess: base.permissions?.subprocess || "none",
    },
  };
}

function copyDirRecursive(source, target) {
  copyDirRecursiveShipSafe(source, target);
}

function backupInstalledSkill(skillId) {
  const source = installedSkillDir(skillId);
  const manifest = readInstalledManifest(skillId);
  if (!manifest || !fs.existsSync(source)) return;

  const backup = skillsBackupDir(skillId, manifest.version);
  if (fs.existsSync(backup)) {
    fs.rmSync(backup, { recursive: true, force: true });
  }
  copyDirRecursive(source, backup);
}

function applySkillPlaceholders(skillDir, manifest) {
  const replacements = buildReplacements(skillDir, manifest);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const skillMd = applyPlaceholders(
      fs.readFileSync(skillMdPath, "utf8"),
      replacements,
    );
    fs.writeFileSync(skillMdPath, skillMd, "utf8");
  }
}

/** @param {object} entry registry entry (zip or github) */
async function installFromRegistryEntry(entry) {
  if (PROTECTED_BUNDLED_IDS.has(entry.id)) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }
  if (entry.minAppVersion && !isAppVersionCompatible(entry.minAppVersion)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "A newer version of the application is required" };
  }

  if (entry.sourceType === "github") {
    return skillGithubInstaller.installFromGithubEntry(entry);
  }

  if (!entry.downloadUrl || !entry.sha256) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "Invalid skill source" };
  }

  const cacheDir = skillsCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const zipName = `${entry.id}-${entry.latestVersion}.skillpack.zip`;
  const zipPath = path.join(cacheDir, zipName);
  const extractDir = path.join(cacheDir, `tmp-${entry.id}-${Date.now()}`);

  try {
    await downloadToFile(entry.downloadUrl, zipPath);
    const hash = sha256File(zipPath);
    if (hash !== entry.sha256.toLowerCase()) {
      return { ok: false, error: "CHECKSUM_MISMATCH" };
    }

    extractZip(zipPath, extractDir);
    walkDirSafe(extractDir, () => {});

    const skillRoot = findSkillRootInArchive(extractDir);
    if (!skillRoot) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "Invalid archive structure (SKILL.md or skill.manifest.json not found)" };
    }

    const skillMdPath = path.join(skillRoot, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "SKILL.md not found" };
    }
    const manifestPath = path.join(skillRoot, "skill.manifest.json");
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
    manifest = normalizeManifestFromRegistry(
      entry,
      manifest,
      fs.readFileSync(skillMdPath, "utf8"),
    );
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const validated = validateManifest(manifest, entry.id);
    if (!validated.ok) return validated;

    if (fs.existsSync(path.join(skillRoot, "node_modules"))) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "node_modules is not allowed in skill packages" };
    }

    if (compareSemver(validated.manifest.version, entry.latestVersion) !== 0) {
      return {
        ok: false,
        error: "INVALID_MANIFEST",
        detail: "Manifest version does not match registry",
      };
    }

    backupInstalledSkill(entry.id);

    const target = installedSkillDir(entry.id);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    copyDirRecursive(skillRoot, target);
    applySkillPlaceholders(target, validated.manifest);

    const state = loadSkillsState();
    const now = new Date().toISOString();
    state.skills[entry.id] = {
      id: entry.id,
      enabled: state.skills[entry.id]?.enabled !== false,
      source: "remote",
      installedVersion: validated.manifest.version,
      installedAt: state.skills[entry.id]?.installedAt || now,
      updatedAt: now,
      sha256: entry.sha256.toLowerCase(),
    };
    saveSkillsState();
  
    return { ok: true, id: entry.id, version: validated.manifest.version };
  } catch (err) {
    if (err.message === "ZIP_SLIP") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "Archive path is unsafe" };
    }
    if (err.message === "SKILLPACK_TOO_LARGE") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "Skill package exceeds size limit" };
    }
    return { ok: false, error: "NETWORK", detail: err.message };
  } finally {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

function uninstallRemoteSkill(skillId) {
  if (PROTECTED_BUNDLED_IDS.has(skillId)) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }

  const state = loadSkillsState();
  const entry = state.skills[skillId];
  if (!entry || entry.source !== "remote") {
    return { ok: false, error: "NOT_FOUND" };
  }

  const target = installedSkillDir(skillId);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  delete state.skills[skillId];
  saveSkillsState();

  return { ok: true };
}

module.exports = {
  installFromRegistryEntry,
  uninstallRemoteSkill,
  sha256Buffer,
};
