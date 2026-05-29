"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const REGISTRY_FETCH_TIMEOUT_MS = 30_000;

function registryCachePath() {
  return userDataPath("skills-cache", "registry.json");
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
  if (!raw?.id || !raw.downloadUrl || !raw.latestVersion || !raw.sha256) {
    return null;
  }
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    description: raw.description ? String(raw.description) : "",
    latestVersion: String(raw.latestVersion),
    downloadUrl: String(raw.downloadUrl),
    sha256: String(raw.sha256).toLowerCase(),
    minAppVersion: raw.minAppVersion ? String(raw.minAppVersion) : null,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
    changelog: raw.changelog ? String(raw.changelog) : "",
    channel: raw.channel ? String(raw.channel) : "stable",
  };
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
      skills,
    },
  };
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

    const cacheDir = path.dirname(registryCachePath());
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      registryCachePath(),
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          sourceUrl: url.trim(),
          ...parsed.registry,
        },
        null,
        2,
      ),
      "utf8",
    );

    return { ok: true, registry: { ...parsed.registry, fetchedAt: new Date().toISOString() } };
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
      skills: raw.skills.map(normalizeRegistryEntry).filter(Boolean),
    };
  } catch {
    return null;
  }
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

module.exports = {
  fetchRegistry,
  loadCachedRegistry,
  parseRegistryJson,
  findRegistryEntry,
  isValidRegistryUrl,
  normalizeRegistryEntry,
};
