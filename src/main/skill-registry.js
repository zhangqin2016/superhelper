"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath, PROJECT_ROOT } = require("./config");

const REGISTRY_FETCH_TIMEOUT_MS = 30_000;
const BUNDLED_REGISTRY_SOURCE = "bundled://local";

function registryCachePath() {
  return userDataPath("skills-cache", "registry.json");
}

function bundledRegistryPath() {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    candidates.push(
      path.join(process.resourcesPath, "resources", "skills-registry", "registry.json"),
    );
  }
  candidates.push(path.join(PROJECT_ROOT, "resources", "skills-registry", "registry.json"));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function isValidRegistryUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeRegistryEntry(raw) {
  if (!raw?.id || !raw.latestVersion) {
    return null;
  }

  const base = {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    description: raw.description ? String(raw.description) : "",
    latestVersion: String(raw.latestVersion),
    minAppVersion: raw.minAppVersion ? String(raw.minAppVersion) : null,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
    changelog: raw.changelog ? String(raw.changelog) : "",
    channel: raw.channel ? String(raw.channel) : "stable",
    category: raw.category ? String(raw.category) : null,
    categoryLabel: raw.categoryLabel ? String(raw.categoryLabel) : null,
    publisher: raw.publisher ? String(raw.publisher) : null,
    sourceRepo: raw.sourceRepo ? String(raw.sourceRepo) : null,
  };

  if (raw.sourceType === "github" || raw.github) {
    const gh = raw.github || {};
    if (!gh.repo || !gh.path) return null;
    return {
      ...base,
      sourceType: "github",
      github: {
        repo: String(gh.repo),
        path: String(gh.path),
        ref: String(gh.ref || "main"),
      },
    };
  }

  if (raw.downloadUrl && raw.sha256) {
    return {
      ...base,
      sourceType: "zip",
      downloadUrl: String(raw.downloadUrl),
      sha256: String(raw.sha256).toLowerCase(),
    };
  }

  return null;
}

function parseRegistryJson(body) {
  let parsed;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, error: "INVALID_REGISTRY" };
  }
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.skills)) {
    return { ok: false, error: "INVALID_REGISTRY" };
  }
  const skills = parsed.skills.map(normalizeRegistryEntry).filter(Boolean);
  return {
    ok: true,
    registry: {
      schemaVersion: 1,
      updatedAt: parsed.updatedAt || null,
      publisher: parsed.publisher || "",
      registryUrl: parsed.registryUrl || null,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      remoteIndexes: Array.isArray(parsed.remoteIndexes) ? parsed.remoteIndexes : [],
      skills,
    },
  };
}

function loadBundledRegistry() {
  const filePath = bundledRegistryPath();
  if (!filePath) return null;
  const parsed = parseRegistryJson(fs.readFileSync(filePath, "utf8"));
  if (!parsed.ok) return null;
  return {
    ...parsed.registry,
    sourceUrl: BUNDLED_REGISTRY_SOURCE,
    bundledPath: filePath,
  };
}

function cacheRegistry(registry, sourceUrl) {
  const cacheDir = path.dirname(registryCachePath());
  fs.mkdirSync(cacheDir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  fs.writeFileSync(
    registryCachePath(),
    JSON.stringify(
      {
        fetchedAt,
        sourceUrl,
        ...registry,
      },
      null,
      2,
    ),
    "utf8",
  );
  return fetchedAt;
}

async function fetchRegistry(url) {
  if (!isValidRegistryUrl(url)) {
    return { ok: false, error: "INVALID_URL" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.trim(), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, error: "NETWORK", detail: `HTTP ${response.status}` };
    }
    const text = await response.text();
    const parsed = parseRegistryJson(text);
    if (!parsed.ok) return parsed;

    const fetchedAt = cacheRegistry(parsed.registry, url.trim());

    return { ok: true, registry: { ...parsed.registry, fetchedAt, sourceUrl: url.trim() } };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: "NETWORK", detail: "请求超时" };
    }
    return { ok: false, error: "NETWORK", detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function loadCachedRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryCachePath(), "utf8"));
    if (!raw?.skills) return null;
    return {
      fetchedAt: raw.fetchedAt || null,
      sourceUrl: raw.sourceUrl || null,
      publisher: raw.publisher || "",
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      remoteIndexes: Array.isArray(raw.remoteIndexes) ? raw.remoteIndexes : [],
      skills: raw.skills.map(normalizeRegistryEntry).filter(Boolean),
    };
  } catch {
    return null;
  }
}

function ensureBundledRegistryCached() {
  const bundled = loadBundledRegistry();
  if (!bundled) return null;
  const cached = loadCachedRegistry();
  if (!cached || cached.sourceUrl !== BUNDLED_REGISTRY_SOURCE) {
    const fetchedAt = cacheRegistry(bundled, BUNDLED_REGISTRY_SOURCE);
    return { ...bundled, fetchedAt };
  }
  return cached;
}

function findRegistryEntry(registry, skillId, version) {
  if (!registry?.skills) return null;
  const matches = registry.skills.filter((s) => s.id === skillId);
  if (matches.length === 0) return null;
  if (version) {
    return matches.find((s) => s.latestVersion === version) || null;
  }
  return matches[0];
}

function registrySourceMatches(state, cached) {
  if (!cached) return false;
  const userUrl = state.registryUrl;
  if (userUrl) return cached.sourceUrl === userUrl;
  return cached.sourceUrl === BUNDLED_REGISTRY_SOURCE;
}

module.exports = {
  BUNDLED_REGISTRY_SOURCE,
  fetchRegistry,
  loadCachedRegistry,
  loadBundledRegistry,
  ensureBundledRegistryCached,
  parseRegistryJson,
  findRegistryEntry,
  isValidRegistryUrl,
  normalizeRegistryEntry,
  registrySourceMatches,
  bundledRegistryPath,
};
