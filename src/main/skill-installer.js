"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { userDataPath, agentConfigDir } = require("./config");
const { compareSemver, isAppVersionCompatible } = require("./skill-version");
const skillGithubInstaller = require("./skill-github-installer");

function skillManager() {
  return require("./skill-manager");
}

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_SKILLPACK_BYTES) {
      throw new Error("SKILLPACK_TOO_LARGE");
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return buffer;
  } finally {
    clearTimeout(timer);
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
    const full = path.join(rootDir, entry.name);
    assertPathInside(rootDir, full);
    callback(entry, full);
    if (entry.isDirectory()) {
      walkDirSafe(full, callback);
    }
  }
}

function findSkillRoot(extractDir) {
  const manifestAtRoot = path.join(extractDir, "skill.manifest.json");
  if (fs.existsSync(manifestAtRoot)) {
    return extractDir;
  }

  const children = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (children.length !== 1) {
    return null;
  }

  const candidate = path.join(extractDir, children[0].name);
  if (fs.existsSync(path.join(candidate, "skill.manifest.json"))) {
    return candidate;
  }
  return null;
}

function validateManifest(manifest, expectedId) {
  if (!manifest || manifest.schemaVersion !== 1) {
    return { ok: false, error: "INVALID_MANIFEST" };
  }
  if (manifest.id !== expectedId) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "技能 ID 与目录不一致" };
  }
  if (manifest.runtime && manifest.runtime !== "node") {
    return { ok: false, error: "INVALID_MANIFEST", detail: "仅支持 node 运行时" };
  }
  if (manifest.minAppVersion && !isAppVersionCompatible(manifest.minAppVersion)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "需要更高版本的应用" };
  }
  return { ok: true, manifest };
}

function copyDirRecursive(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      if (
        process.platform !== "win32" &&
        (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
      ) {
        fs.chmodSync(dst, 0o755);
      }
    }
  }
}

function backupInstalledSkill(skillId) {
  const mgr = skillManager();
  const source = mgr.installedSkillDir(skillId);
  const manifest = mgr.readInstalledManifest(skillId);
  if (!manifest || !fs.existsSync(source)) return;

  const backup = skillsBackupDir(skillId, manifest.version);
  if (fs.existsSync(backup)) {
    fs.rmSync(backup, { recursive: true, force: true });
  }
  copyDirRecursive(source, backup);
}

function applySkillPlaceholders(skillDir, manifest) {
  const mgr = skillManager();
  const replacements = mgr.buildReplacements(skillDir, manifest);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const skillMd = mgr.applyPlaceholders(
      fs.readFileSync(skillMdPath, "utf8"),
      replacements,
    );
    fs.writeFileSync(skillMdPath, skillMd, "utf8");
  }
}

/** @param {object} entry registry entry (zip or github) */
async function installFromRegistryEntry(entry) {
  const mgr = skillManager();
  if (mgr.PROTECTED_BUNDLED_IDS.has(entry.id)) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }
  if (entry.minAppVersion && !isAppVersionCompatible(entry.minAppVersion)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "需要更高版本的应用" };
  }

  if (entry.sourceType === "github") {
    return skillGithubInstaller.installFromGithubEntry(entry);
  }

  if (!entry.downloadUrl || !entry.sha256) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "技能源无效" };
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

    const skillRoot = findSkillRoot(extractDir);
    if (!skillRoot) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "压缩包结构无效" };
    }

    const manifestPath = path.join(skillRoot, "skill.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const validated = validateManifest(manifest, entry.id);
    if (!validated.ok) return validated;

    if (fs.existsSync(path.join(skillRoot, "node_modules"))) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "禁止包含 node_modules" };
    }

    if (compareSemver(validated.manifest.version, entry.latestVersion) !== 0) {
      return {
        ok: false,
        error: "INVALID_MANIFEST",
        detail: "manifest 版本与 registry 不一致",
      };
    }

    backupInstalledSkill(entry.id);

    const target = mgr.installedSkillDir(entry.id);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    copyDirRecursive(skillRoot, target);
    applySkillPlaceholders(target, validated.manifest);

    const state = mgr.loadSkillsState();
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
    mgr.saveSkillsState();
    mgr.mergeAgentGuide();

    return { ok: true, id: entry.id, version: validated.manifest.version };
  } catch (err) {
    if (err.message === "ZIP_SLIP") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "压缩包路径不安全" };
    }
    if (err.message === "SKILLPACK_TOO_LARGE") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "技能包超过大小上限" };
    }
    return { ok: false, error: "NETWORK", detail: err.message };
  } finally {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

function uninstallRemoteSkill(skillId) {
  const mgr = skillManager();
  if (mgr.PROTECTED_BUNDLED_IDS.has(skillId)) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }

  const state = mgr.loadSkillsState();
  const entry = state.skills[skillId];
  if (!entry || entry.source !== "remote") {
    return { ok: false, error: "NOT_FOUND" };
  }

  const target = mgr.installedSkillDir(skillId);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  delete state.skills[skillId];
  mgr.saveSkillsState();
  mgr.mergeAgentGuide();

  return { ok: true };
}

module.exports = {
  installFromRegistryEntry,
  uninstallRemoteSkill,
  sha256Buffer,
};
