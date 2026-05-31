"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { userDataPath } = require("./config");
const { isAppVersionCompatible } = require("./skill-version");
const { buildManifestFromSkillMd } = require("./skill-md-convert");
const { resolveBundledCatalogDir } = require("./skill-bundled-catalog");
const { findSkillRoot } = require("./skill-root");
const { copyDirRecursiveShipSafe, isShipIgnoredEntry } = require("./ship-ignore");

function skillManager() {
  return require("./skill-manager");
}

const FETCH_TIMEOUT_MS = 60_000;
const MAX_SKILL_DIR_BYTES = 3 * 1024 * 1024;
function skillsCacheDir() {
  return userDataPath("skills-cache");
}

function copyDirRecursive(source, target) {
  copyDirRecursiveShipSafe(source, target, { chmodJs: false });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "lily-workbench" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "lily-workbench" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function dirSize(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (isShipIgnoredEntry(entry.name, entry.isDirectory())) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

async function downloadGithubPath(repo, remotePath, ref, destDir) {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${remotePath}?ref=${encodeURIComponent(ref)}`;
  const entries = await fetchJson(apiUrl);
  if (!Array.isArray(entries)) {
    if (entries?.type === "file" && entries.download_url) {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      const text = await fetchText(entries.download_url);
      fs.writeFileSync(destDir, text, "utf8");
      return;
    }
    throw new Error("目录结构无效");
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    if (isShipIgnoredEntry(entry.name, entry.type === "dir")) continue;
    const local = path.join(destDir, entry.name);
    if (entry.type === "file") {
      if (!entry.download_url) continue;
      const text = await fetchText(entry.download_url);
      fs.writeFileSync(local, text, "utf8");
      if (dirSize(destDir) > MAX_SKILL_DIR_BYTES) {
        throw new Error("SKILL_TOO_LARGE");
      }
      continue;
    }
    if (entry.type === "dir") {
      await downloadGithubPath(repo, entry.path, ref, local);
      if (dirSize(destDir) > MAX_SKILL_DIR_BYTES) {
        throw new Error("SKILL_TOO_LARGE");
      }
    }
  }
}

function resetExtractDir(extractDir) {
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });
}

function materializeFromBundled(entry, extractDir) {
  const bundledDir = resolveBundledCatalogDir(entry.id);
  if (!bundledDir) return false;
  resetExtractDir(extractDir);
  copyDirRecursive(bundledDir, extractDir);
  return true;
}

async function materializeFromGithub(entry, extractDir) {
  resetExtractDir(extractDir);
  const ref = entry.github.ref || "main";
  await downloadGithubPath(entry.github.repo, entry.github.path, ref, extractDir);
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

function finalizeInstalledSkill(entry, extractDir) {
  const mgr = skillManager();
  const skillRoot = findSkillRoot(extractDir);
  if (!skillRoot) {
    return {
      ok: false,
      error: "INVALID_MANIFEST",
      detail: "未找到 SKILL.md 或 skill.manifest.json（目录结构无效）",
    };
  }

  const skillMdPath = path.join(skillRoot, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "未找到 SKILL.md" };
  }

  const skillMd = fs.readFileSync(skillMdPath, "utf8");
  let manifest;
  const existingManifestPath = path.join(skillRoot, "skill.manifest.json");
  if (fs.existsSync(existingManifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(existingManifestPath, "utf8"));
      if (manifest.id && manifest.id !== entry.id) {
        return {
          ok: false,
          error: "INVALID_MANIFEST",
          detail: "技能 ID 与目录不一致",
        };
      }
      manifest.id = entry.id;
      if (!manifest.version) manifest.version = entry.latestVersion;
    } catch (err) {
      return {
        ok: false,
        error: "INVALID_MANIFEST",
        detail: `skill.manifest.json 无法解析：${err.message}`,
      };
    }
  } else {
    manifest = buildManifestFromSkillMd({
      skillId: entry.id,
      skillMd,
      version: entry.latestVersion,
    });
    fs.writeFileSync(
      existingManifestPath,
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  const target = mgr.installedSkillDir(entry.id);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  copyDirRecursive(skillRoot, target);
  applySkillPlaceholders(target, manifest);

  const state = mgr.loadSkillsState();
  const now = new Date().toISOString();
  const prev = state.skills[entry.id];
  state.skills[entry.id] = {
    id: entry.id,
    enabled: prev ? prev.enabled !== false : true,
    source: "remote",
    installedVersion: entry.latestVersion,
    installedAt: prev?.installedAt || now,
    updatedAt: now,
    githubRef: `${entry.github.repo}@${entry.github.ref || "main"}:${entry.github.path}`,
  };
  mgr.saveSkillsState();
  mgr.mergeAgentGuide();

  return { ok: true, id: entry.id, version: entry.latestVersion };
}

function networkErrorDetail(err) {
  if (/HTTP 403/.test(err.message)) {
    if (app.isPackaged) {
      return "内置技能包未找到且无法访问 GitHub。请更新到最新安装包，或检查是否完整安装。";
    }
    return "无法访问 GitHub（403/限流）。开发环境请运行 npm run sync:skills-bundle 使用离线包。";
  }
  return err.message;
}

/**
 * @param {{ id: string, latestVersion: string, github: { repo: string, path: string, ref?: string }, minAppVersion?: string | null }} entry
 */
async function installFromGithubEntry(entry) {
  const mgr = skillManager();
  if (mgr.PROTECTED_BUNDLED_IDS.has(entry.id)) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }
  if (!entry.github?.repo || !entry.github?.path) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "缺少 GitHub 源信息" };
  }
  if (entry.minAppVersion && !isAppVersionCompatible(entry.minAppVersion)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "需要更高版本的应用" };
  }

  const cacheDir = skillsCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const extractDir = path.join(cacheDir, `gh-${entry.id}-${Date.now()}`);

  try {
    let usedGithub = false;
    if (materializeFromBundled(entry, extractDir)) {
      // offline catalog
    } else if (app.isPackaged) {
      return {
        ok: false,
        error: "BUNDLED_MISSING",
        detail: `安装包内缺少技能「${entry.id}」的离线文件，请更新应用。`,
      };
    } else {
      await materializeFromGithub(entry, extractDir);
      usedGithub = true;
    }

    const result = finalizeInstalledSkill(entry, extractDir);
    if (result.ok || !usedGithub) return result;

    // Dev-only: GitHub manifest invalid — retry bundled if sync added it since start
    if (materializeFromBundled(entry, extractDir)) {
      return finalizeInstalledSkill(entry, extractDir);
    }
    return result;
  } catch (err) {
    if (err.message === "SKILL_TOO_LARGE") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "技能包超过大小上限" };
    }

    // GitHub failed — fall back to bundled catalog when available (common in CN networks)
    resetExtractDir(extractDir);
    if (materializeFromBundled(entry, extractDir)) {
      try {
        const recovered = finalizeInstalledSkill(entry, extractDir);
        if (recovered.ok) return recovered;
      } catch (finalizeErr) {
        return {
          ok: false,
          error: "INVALID_MANIFEST",
          detail: finalizeErr.message,
        };
      }
    }

    if (app.isPackaged) {
      return {
        ok: false,
        error: "BUNDLED_MISSING",
        detail: networkErrorDetail(err),
      };
    }

    return {
      ok: false,
      error: "NETWORK",
      detail: networkErrorDetail(err),
    };
  } finally {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  installFromGithubEntry,
  downloadGithubPath,
};
