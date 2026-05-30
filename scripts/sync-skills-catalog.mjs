#!/usr/bin/env node
/**
 * Sync GitHub skill sources into resources/skills-registry/registry.json
 * and bundle skill files into resources/skills-catalog/<id>/ (offline install).
 *
 * Usage:
 *   node scripts/sync-skills-catalog.mjs           # refresh registry + bundle
 *   node scripts/sync-skills-catalog.mjs --bundle-only  # bundle from existing registry.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "resources/skills-registry/catalog-sources.json");
const OUT_PATH = path.join(ROOT, "resources/skills-registry/registry.json");
const CATALOG_DIR = path.join(ROOT, "resources/skills-catalog");
const BLOCKED_NAMES = new Set(["node_modules", ".git", ".github"]);

const GITHUB_API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "lily-workbench-sync",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ghJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  await sleep(120);
  return res.json();
}

async function ghText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  await sleep(80);
  return res.text();
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return meta;
}

function slugToTitle(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function makeEntry({ id, name, description, repo, skillPath, ref, source }) {
  return {
    id,
    name,
    description,
    latestVersion: "1.0.0",
    channel: "stable",
    sourceType: "github",
    github: { repo, path: skillPath, ref },
    minAppVersion: "0.1.0",
    category: source.category,
    categoryLabel: source.categoryLabel,
    publisher: source.publisher,
    sourceRepo: repo,
    changelog: `来自 ${repo}`,
  };
}

async function readSkillMeta(repo, skillPath, ref, fallbackName) {
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${ref}/${skillPath}/SKILL.md`;
  try {
    const text = await ghText(rawUrl);
    const meta = parseFrontmatter(text);
    const slug = path.basename(skillPath);
    return {
      name: meta.name ? slugToTitle(meta.name) : slugToTitle(fallbackName || slug),
      description: meta.description || "",
    };
  } catch {
    return {
      name: slugToTitle(fallbackName || path.basename(skillPath)),
      description: "",
    };
  }
}

async function listSkillDirs(repo, basePath, ref) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${basePath}?ref=${encodeURIComponent(ref)}`;
  const entries = await ghJson(url);
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e.type === "dir").map((e) => e.name);
}

async function collectFlatSkills(source) {
  const dirs = await listSkillDirs(source.repo, source.path, source.ref || "main");
  const skills = [];
  for (const dir of dirs) {
    if (source.exclude?.includes(dir)) continue;
    if (source.includeOnly && !source.includeOnly.includes(dir)) continue;
    const skillPath = `${source.path}/${dir}`;
    const id = `${source.prefix}-${dir}`;
    const meta = await readSkillMeta(source.repo, skillPath, source.ref || "main", dir);
    skills.push(
      makeEntry({
        id,
        name: meta.name,
        description: meta.description,
        repo: source.repo,
        skillPath,
        ref: source.ref || "main",
        source,
      }),
    );
  }
  return skills;
}

async function collectPluginSkills(source) {
  const plugins = await listSkillDirs(source.repo, source.path, source.ref || "main");
  const skills = [];
  for (const plugin of plugins) {
    const skillsBase = `${source.path}/${plugin}/skills`;
    let skillDirs = [];
    try {
      skillDirs = await listSkillDirs(source.repo, skillsBase, source.ref || "main");
    } catch {
      continue;
    }
    for (const dir of skillDirs) {
      const skillPath = `${skillsBase}/${dir}`;
      const id = `${source.prefix}-${plugin}-${dir}`;
      const meta = await readSkillMeta(source.repo, skillPath, source.ref || "main", dir);
      skills.push(
        makeEntry({
          id,
          name: meta.name,
          description: meta.description,
          repo: source.repo,
          skillPath,
          ref: source.ref || "main",
          source,
        }),
      );
    }
  }
  return skills;
}

function copyDirRecursive(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (BLOCKED_NAMES.has(entry.name)) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

async function downloadZip(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`zip download failed: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
}

async function ensureRepoExtracted(repo, ref) {
  const cacheDir = path.join(ROOT, ".cache", "skill-repos", repo.replace("/", "__"), ref);
  const marker = path.join(cacheDir, "ok");
  const treeDir = path.join(cacheDir, "tree");

  if (fs.existsSync(marker)) {
    const [folder] = fs.readdirSync(treeDir);
    return path.join(treeDir, folder);
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, "repo.zip");
  const url = `https://codeload.github.com/${repo}/zip/refs/heads/${ref}`;
  console.log(`  Downloading ${repo}@${ref}...`);
  await downloadZip(url, zipPath);

  fs.mkdirSync(treeDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", treeDir], { stdio: "pipe" });
  fs.writeFileSync(marker, new Date().toISOString(), "utf8");

  const [folder] = fs.readdirSync(treeDir);
  if (!folder) {
    throw new Error(`empty zip extract for ${repo}`);
  }
  return path.join(treeDir, folder);
}

async function bundleSkills(skills) {
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const repoRoots = new Map();
  let bundled = 0;
  let skipped = 0;

  for (const skill of skills) {
    if (!skill.github?.repo || !skill.github?.path) {
      skipped += 1;
      continue;
    }
    const ref = skill.github.ref || "main";
    const cacheKey = `${skill.github.repo}@${ref}`;
    if (!repoRoots.has(cacheKey)) {
      repoRoots.set(cacheKey, await ensureRepoExtracted(skill.github.repo, ref));
    }
    const repoRoot = repoRoots.get(cacheKey);
    const src = path.join(repoRoot, skill.github.path);
    const dest = path.join(CATALOG_DIR, skill.id);

    if (!fs.existsSync(path.join(src, "SKILL.md"))) {
      console.warn(`  skip bundle (no SKILL.md): ${skill.id}`);
      skipped += 1;
      continue;
    }

    fs.rmSync(dest, { recursive: true, force: true });
    copyDirRecursive(src, dest);
    bundled += 1;
  }

  console.log(`Bundled ${bundled} skills to ${CATALOG_DIR} (${skipped} skipped)`);
}

async function main() {
  const bundleOnly = process.argv.includes("--bundle-only");
  let allSkills = [];

  if (bundleOnly) {
    const registry = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    allSkills = registry.skills || [];
    console.log(`Bundle-only mode: ${allSkills.length} skills from registry.json`);
    await bundleSkills(allSkills);
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const seen = new Set();

  for (const source of catalog.sources) {
    console.log(`Syncing ${source.repo} (${source.categoryLabel})...`);
    const batch =
      source.mode === "plugin-skills"
        ? await collectPluginSkills(source)
        : await collectFlatSkills(source);
    for (const skill of batch) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      allSkills.push(skill);
    }
    console.log(`  +${batch.length} skills`);
  }

  allSkills.sort((a, b) => {
    const cat = (a.category || "").localeCompare(b.category || "");
    if (cat !== 0) return cat;
    return a.name.localeCompare(b.name);
  });

  const registry = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    publisher: "智能工作台技能目录",
    registryUrl: null,
    categories: catalog.categories,
    remoteIndexes: catalog.remoteIndexes || [],
    skills: allSkills,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(registry, null, 2), "utf8");
  console.log(`Wrote ${allSkills.length} skills to ${OUT_PATH}`);

  console.log("Bundling skill files for offline install...");
  await bundleSkills(allSkills);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
