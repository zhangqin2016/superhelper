"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");
const { isAppVersionCompatible } = require("./skill-version");
const { buildManifestFromSkillMd } = require("./skill-md-convert");
const { resolveBundledCatalogDir } = require("./skill-bundled-catalog");

function skillManager() {
  return require("./skill-manager");
}

const FETCH_TIMEOUT_MS = 60_000;
const MAX_SKILL_DIR_BYTES = 3 * 1024 * 1024;
const BLOCKED_DIRS = new Set(["node_modules", ".git", ".github"]);

function skillsCacheDir() {
  return userDataPath("skills-cache");
}

function copyDirRecursive(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      fs.writeFileSync(dst, fs.readFileSync(src));
    }
  }
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
    if (BLOCKED_DIRS.has(entry.name)) continue;
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

  const ref = entry.github.ref || "main";
  const cacheDir = skillsCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const extractDir = path.join(cacheDir, `gh-${entry.id}-${Date.now()}`);

  try {
    const bundledDir = resolveBundledCatalogDir(entry.id);
    if (bundledDir) {
      copyDirRecursive(bundledDir, extractDir);
    } else {
      await downloadGithubPath(entry.github.repo, entry.github.path, ref, extractDir);
    }

    const skillMdPath = path.join(extractDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "未找到 SKILL.md" };
    }

    const skillMd = fs.readFileSync(skillMdPath, "utf8");
    const manifest = buildManifestFromSkillMd({
      skillId: entry.id,
      skillMd,
      version: entry.latestVersion,
    });

    fs.writeFileSync(
      path.join(extractDir, "skill.manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    const target = mgr.installedSkillDir(entry.id);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    copyDirRecursive(extractDir, target);

    const state = mgr.loadSkillsState();
    const now = new Date().toISOString();
    const prev = state.skills[entry.id];
    state.skills[entry.id] = {
      id: entry.id,
      enabled: prev ? prev.enabled !== false : false,
      source: "remote",
      installedVersion: entry.latestVersion,
      installedAt: prev?.installedAt || now,
      updatedAt: now,
      githubRef: `${entry.github.repo}@${ref}:${entry.github.path}`,
    };
    mgr.saveSkillsState();
    mgr.mergeAgentGuide();

    return { ok: true, id: entry.id, version: entry.latestVersion };
  } catch (err) {
    if (err.message === "SKILL_TOO_LARGE") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "技能包超过大小上限" };
    }
    const is403 = /HTTP 403/.test(err.message);
    return {
      ok: false,
      error: "NETWORK",
      detail: is403
        ? "内置技能包缺失且无法访问 GitHub，请更新应用或稍后重试"
        : err.message,
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
