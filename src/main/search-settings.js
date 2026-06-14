"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT, userDataPath } = require("./config");

const SEARCH_PROVIDERS = [
  {
    id: "iqs",
    label: "Alibaba IQS",
    description: "Direct connection, stable, compliant for commercial use. Built-in.",
  },
  {
    id: "searxng",
    label: "SearXNG",
    description: "Open-source metasearch engine, no tracking, no API key required.",
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    description: "Direct DuckDuckGo Lite connection, no API key required.",
  },
];

const DEFAULT_PROVIDER = "iqs";

/** @type {{ providerId: string, searxngUrl?: string } | null} */
let cachedChoice = null;

function userSettingsPath() {
  return userDataPath("search-settings.json");
}

function bundledSettingsCandidates() {
  return [
    path.join(process.resourcesPath, "resources", "agent-defaults", "settings.json"),
    path.join(PROJECT_ROOT, "resources", "agent-defaults", "settings.json"),
  ];
}

function readBundledSettingsEnv() {
  for (const filePath of bundledSettingsCandidates()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (raw?.env && typeof raw.env === "object") return raw.env;
    } catch {
      // try next candidate
    }
  }
  return {};
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function isValidProvider(providerId) {
  return SEARCH_PROVIDERS.some((item) => item.id === providerId);
}

function normalizeSearxngUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function resolveIqsApiKey() {
  try {
    const remoteEnv = require("./remote-config").getRemoteRuntimeEnvSync();
    const fromRemote = String(remoteEnv.IQS_API_KEY || remoteEnv.WEBSEARCH_IQS_API_KEY || "").trim();
    if (fromRemote) return fromRemote;
  } catch {
    // fall through
  }
  try {
    const { loadSettingsEnv } = require("./agent-settings");
    const userEnv = loadSettingsEnv();
    const fromUser = String(userEnv.IQS_API_KEY || userEnv.WEBSEARCH_IQS_API_KEY || "").trim();
    if (fromUser) return fromUser;
  } catch {
    // fall through
  }
  const stored = readJson(userSettingsPath(), null);
  const fromSearchSettings = String(stored?.iqsApiKey || "").trim();
  if (fromSearchSettings) return fromSearchSettings;
  const bundled = readBundledSettingsEnv();
  return String(bundled.IQS_API_KEY || bundled.WEBSEARCH_IQS_API_KEY || "").trim();
}

function loadSettings() {
  if (cachedChoice) return cachedChoice;
  const stored = readJson(userSettingsPath(), null);
  const providerId =
    stored?.providerId && isValidProvider(stored.providerId)
      ? stored.providerId
      : DEFAULT_PROVIDER;
  const searxngUrl =
    stored?.searxngUrl && normalizeSearxngUrl(stored.searxngUrl)
      ? normalizeSearxngUrl(stored.searxngUrl)
      : "";
  cachedChoice = { providerId, searxngUrl };
  return cachedChoice;
}

function saveSettings(next) {
  cachedChoice = next;
  writeJson(userSettingsPath(), next);
}

function listSearchSettingsPublic() {
  const settings = loadSettings();
  return {
    providerId: settings.providerId,
    searxngUrl: settings.searxngUrl || "",
    providers: SEARCH_PROVIDERS.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  };
}

function setSearchProvider(providerId) {
  if (!isValidProvider(providerId)) return { ok: false, error: "NOT_FOUND" };
  const current = loadSettings();
  saveSettings({ ...current, providerId });
  const provider = SEARCH_PROVIDERS.find((item) => item.id === providerId);
  return { ok: true, providerId, label: provider?.label || providerId };
}

function setSearxngUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  const current = loadSettings();
  if (!trimmed) {
    saveSettings({ ...current, searxngUrl: "" });
    return { ok: true, searxngUrl: "" };
  }
  const normalized = normalizeSearxngUrl(trimmed);
  if (!normalized) return { ok: false, error: "INVALID_URL" };
  saveSettings({ ...current, searxngUrl: normalized });
  return { ok: true, searxngUrl: normalized };
}

// Server-delivered search proxy endpoint. When present, the IQS key resolves to
// a short-lived gateway token (resolveIqsApiKey reads it from the same remote
// runtime env), so the token must be sent here (our proxy verifies it and
// injects the real IQS key) — NOT to the default direct IQS endpoint. This key
// is not a passthrough prefix, so the spawn env (not the engine env) must carry
// it for websearch.cjs to see it.
function resolveIqsApiUrl() {
  try {
    const remoteEnv = require("./remote-config").getRemoteRuntimeEnvSync();
    return String(remoteEnv.WEBSEARCH_IQS_API_URL || "").trim();
  } catch {
    return "";
  }
}

/** Env vars injected when spawning the agent (picked up by websearch.cjs). */
function getSearchSpawnEnv() {
  const settings = loadSettings();
  const env = {
    WEBSEARCH_PROVIDER: settings.providerId || DEFAULT_PROVIDER,
    WEBSEARCH_IQS_ENGINE_TYPE: "LiteAdvanced",
  };
  if (settings.searxngUrl) {
    env.WEBSEARCH_SEARXNG_URL = settings.searxngUrl;
  }
  const iqsKey = resolveIqsApiKey();
  if (iqsKey) {
    env.WEBSEARCH_IQS_API_KEY = iqsKey;
  }
  const iqsUrl = resolveIqsApiUrl();
  if (iqsUrl) {
    env.WEBSEARCH_IQS_API_URL = iqsUrl;
  }
  return env;
}

module.exports = {
  listSearchSettingsPublic,
  setSearchProvider,
  setSearxngUrl,
  getSearchSpawnEnv,
};
