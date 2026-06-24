"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath, PROJECT_ROOT } = require("./config");
const { normalizeSkillCapabilityContract } = require("./skill-capability-contract");

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

// Registry metadata decides what code the agent will run later — treat its
// transport as a supply-chain boundary: HTTPS only. Plain http is allowed
// solely for loopback hosts (local registry development).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isValidRegistryUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Git repo/refs reach download code paths — constrain charset and shape.
const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_REF_RE = /^[\w./-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function normalizeStringMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (!locale || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out[String(locale)] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeRegistryEntry(raw, capabilityOverride = null) {
  if (!raw?.id || !raw.latestVersion) {
    return null;
  }
  const rawCapability = capabilityOverride || raw.capability || null;

  const base = {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    name_i18n: normalizeStringMap(raw.name_i18n),
    description: raw.description ? String(raw.description) : "",
    description_i18n: normalizeStringMap(raw.description_i18n),
    latestVersion: String(raw.latestVersion),
    minAppVersion: raw.minAppVersion ? String(raw.minAppVersion) : null,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
    changelog: raw.changelog ? String(raw.changelog) : "",
    channel: raw.channel ? String(raw.channel) : "stable",
    category: raw.category ? String(raw.category) : null,
    categoryLabel: raw.categoryLabel ? String(raw.categoryLabel) : null,
    categoryLabel_i18n: normalizeStringMap(raw.categoryLabel_i18n),
    publisher: raw.publisher ? String(raw.publisher) : null,
    sourceRepo: raw.sourceRepo ? String(raw.sourceRepo) : null,
    capabilityLayer: raw.capabilityLayer ? String(raw.capabilityLayer) : "core",
    riskLevel: raw.riskLevel ? String(raw.riskLevel) : "low",
    defaultEligible: Boolean(raw.defaultEligible),
    featured: Boolean(raw.featured),
    displayInCatalog: raw.displayInCatalog !== false,
    changelog_i18n: normalizeStringMap(raw.changelog_i18n),
    capability: normalizeSkillCapabilityContract(rawCapability, {
      capabilityLayer: raw.capabilityLayer,
      riskLevel: raw.riskLevel,
    }),
  };

  if (raw.sourceType === "github" || raw.github) {
    const gh = raw.github || {};
    if (!gh.repo || !gh.path) return null;
    const repo = String(gh.repo);
    const ref = String(gh.ref || "main");
    const ghPath = String(gh.path);
    if (!GITHUB_REPO_RE.test(repo) || !GITHUB_REF_RE.test(ref)) return null;
    if (ghPath.includes("..") || ghPath.startsWith("/")) return null;
    return {
      ...base,
      sourceType: "github",
      github: { repo, path: ghPath, ref },
    };
  }

  if (raw.downloadUrl && raw.sha256) {
    const downloadUrl = String(raw.downloadUrl);
    const sha256 = String(raw.sha256).toLowerCase();
    // The artifact URL rides the same trust rules as the registry itself, and
    // a malformed hash must fail HERE, not pass a useless comparison later.
    if (!isValidRegistryUrl(downloadUrl) || !SHA256_RE.test(sha256)) return null;
    return {
      ...base,
      sourceType: "zip",
      downloadUrl,
      sha256,
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
  const capabilityMap =
    parsed.capabilities && typeof parsed.capabilities === "object" && !Array.isArray(parsed.capabilities)
      ? parsed.capabilities
      : {};
  const skills = parsed.skills
    .map((entry) => normalizeRegistryEntry(entry, capabilityMap[entry?.id]))
    .filter(Boolean);
  return {
    ok: true,
    registry: {
      schemaVersion: 1,
      updatedAt: parsed.updatedAt || null,
      publisher: parsed.publisher || "",
      registryUrl: parsed.registryUrl || null,
      categories: mergeCategoryLists(parsed.categories),
      capabilities: capabilityMap,
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
      return { ok: false, error: "NETWORK", detail: "Request timed out" };
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
      updatedAt: raw.updatedAt || null,
      publisher: raw.publisher || "",
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      capabilities: raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {},
      remoteIndexes: Array.isArray(raw.remoteIndexes) ? raw.remoteIndexes : [],
      skills: raw.skills.map((entry) => normalizeRegistryEntry(entry, raw.capabilities?.[entry?.id])).filter(Boolean),
    };
  } catch {
    return null;
  }
}

function ensureBundledRegistryCached() {
  const bundled = loadBundledRegistry();
  if (!bundled) return null;
  const cached = loadCachedRegistry();
  const cachedIds = (cached?.skills || []).map((entry) => entry.id).join("\n");
  const bundledIds = (bundled.skills || []).map((entry) => entry.id).join("\n");
  if (
    !cached ||
    cached.sourceUrl !== BUNDLED_REGISTRY_SOURCE ||
    cached.updatedAt !== bundled.updatedAt ||
    cachedIds !== bundledIds
  ) {
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

function mergeCategoryLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const cat of list) {
      if (!cat?.id) continue;
      byId.set(String(cat.id), {
        id: String(cat.id),
        label: cat.label ? String(cat.label) : String(cat.id),
        label_i18n: normalizeStringMap(cat.label_i18n),
      });
    }
  }
  return Array.from(byId.values());
}

function categoriesForRegistry(registry) {
  const explicit = mergeCategoryLists(registry?.categories);
  if (explicit.length > 0) return explicit;

  const byId = new Map();
  for (const skill of registry?.skills || []) {
    if (!skill?.category) continue;
    if (byId.has(skill.category)) continue;
    byId.set(skill.category, {
      id: skill.category,
      label: skill.categoryLabel || skill.category,
      label_i18n: skill.categoryLabel_i18n || null,
    });
  }
  const derived = Array.from(byId.values());
  if (derived.length > 0) return derived;
  return mergeCategoryLists(loadBundledRegistry()?.categories);
}

function capabilitiesForSkills(skills) {
  const out = {};
  for (const skill of skills || []) {
    if (skill?.id && skill.capability) out[skill.id] = skill.capability;
  }
  return out;
}

/** Service entries win on id collision; bundled fills gaps for offline catalog. */
function mergeRegistries(primary, bundled) {
  if (!bundled?.skills?.length) {
    if (!primary) return null;
    return {
      ...primary,
      categories: categoriesForRegistry(primary),
      capabilities: capabilitiesForSkills(primary.skills),
    };
  }
  if (!primary?.skills?.length) {
    return {
      ...bundled,
      sourceUrl: primary?.sourceUrl || bundled.sourceUrl,
      fetchedAt: primary?.fetchedAt || bundled.fetchedAt || null,
      publisher: primary?.publisher || bundled.publisher || "",
      categories: mergeCategoryLists(primary?.categories, bundled.categories),
      capabilities: capabilitiesForSkills(bundled.skills),
      bundledFallback: true,
    };
  }

  const byId = new Map(bundled.skills.map((entry) => [entry.id, entry]));
  for (const entry of primary.skills) {
    byId.set(entry.id, entry);
  }

  const categories = mergeCategoryLists(primary.categories, bundled.categories);

  const seenIndexUrls = new Set();
  const remoteIndexes = [];
  for (const item of [...(primary.remoteIndexes || []), ...(bundled.remoteIndexes || [])]) {
    const url = item?.url ? String(item.url) : "";
    if (!url || seenIndexUrls.has(url)) continue;
    seenIndexUrls.add(url);
    remoteIndexes.push(item);
  }

  const bundledOnlyCount = bundled.skills.filter((entry) => {
    return !primary.skills.some((primaryEntry) => primaryEntry.id === entry.id);
  }).length;

  return {
    ...primary,
    skills: Array.from(byId.values()),
    categories,
    capabilities: capabilitiesForSkills(Array.from(byId.values())),
    remoteIndexes,
    bundledSupplement: bundledOnlyCount > 0,
    bundledFallback: false,
  };
}

function supplementRegistryWithBundled(registry) {
  const bundled = loadBundledRegistry() || ensureBundledRegistryCached();
  if (!registry) return bundled;
  const merged = mergeRegistries(registry, bundled);
  if (!merged) return bundled;
  return {
    ...merged,
    categories: categoriesForRegistry(merged),
  };
}

function registrySourceMatches(state, cached) {
  if (!cached) return false;
  return cached.sourceUrl === BUNDLED_REGISTRY_SOURCE || cached.sourceUrl === state.serviceRegistryUrl;
}

module.exports = {
  BUNDLED_REGISTRY_SOURCE,
  fetchRegistry,
  loadCachedRegistry,
  loadBundledRegistry,
  ensureBundledRegistryCached,
  parseRegistryJson,
  cacheRegistry,
  findRegistryEntry,
  mergeRegistries,
  mergeCategoryLists,
  categoriesForRegistry,
  supplementRegistryWithBundled,
  isValidRegistryUrl,
  normalizeRegistryEntry,
  registrySourceMatches,
  bundledRegistryPath,
};
