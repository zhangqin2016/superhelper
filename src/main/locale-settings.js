"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { userDataPath } = require("./config");

const SUPPORTED_LOCALES = ["zh-CN", "en", "ar"];
const DEFAULT_LOCALE = "zh-CN";

/** @type {{ locale: string } | null} */
let cached = null;

function preferencesPath() {
  return userDataPath("app-preferences.json");
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

/**
 * Map OS / ICU locale tag to a supported UI locale.
 * @param {string} raw
 */
function mapToSupportedLocale(raw) {
  const tag = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!tag) return "en";
  if (tag.startsWith("zh")) return "zh-CN";
  if (tag.startsWith("ar")) return "ar";
  if (tag.startsWith("en")) return "en";
  const primary = tag.split("-")[0];
  if (primary === "zh") return "zh-CN";
  if (primary === "ar") return "ar";
  if (primary === "en") return "en";
  return "en";
}

function detectSystemLocale() {
  const raw =
    (typeof app.getSystemLocale === "function" && app.getSystemLocale()) ||
    app.getLocale() ||
    DEFAULT_LOCALE;
  return mapToSupportedLocale(raw);
}

function normalizeLocale(raw) {
  const value = String(raw || "").trim();
  if (SUPPORTED_LOCALES.includes(value)) return value;
  return DEFAULT_LOCALE;
}

function loadPreferences() {
  if (cached) return cached;
  const stored = readJson(preferencesPath(), null);
  if (stored?.locale && SUPPORTED_LOCALES.includes(stored.locale)) {
    cached = { locale: stored.locale };
    return cached;
  }
  cached = { locale: detectSystemLocale() };
  return cached;
}

function getLocale() {
  return loadPreferences().locale;
}

function setLocale(locale) {
  const next = normalizeLocale(locale);
  cached = { locale: next };
  writeJson(preferencesPath(), { locale: next, localeUserSet: true });
  return { ok: true, locale: next };
}

function listLocalesPublic() {
  return {
    locale: getLocale(),
    supported: SUPPORTED_LOCALES,
    defaultLocale: DEFAULT_LOCALE,
    systemLocale: detectSystemLocale(),
  };
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  mapToSupportedLocale,
  detectSystemLocale,
  getLocale,
  setLocale,
  listLocalesPublic,
};
