/**
 * Lightweight i18n for renderer (zh-CN / en / ar).
 */

const SUPPORTED = ["zh-CN", "en", "ar"];
const RTL = new Set(["ar"]);
const FALLBACK = "zh-CN";

/** @type {string} */
let currentLocale = FALLBACK;
/** @type {Record<string, string>} */
let messages = {};
/** @type {Record<string, string>} */
let fallbackMessages = {};
/** @type {Record<string, { name?: string, description?: string }>} */
let skillCatalog = {};

const localeChangeListeners = new Set();

function interpolate(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return String(params[key]);
    }
    return `{${key}}`;
  });
}

async function loadSkillCatalog(locale) {
  try {
    const res = await fetch(new URL(`./locales/skills/${locale}.json`, import.meta.url));
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

async function loadMessages(locale) {
  const res = await fetch(new URL(`./locales/${locale}.json`, import.meta.url));
  if (!res.ok) {
    throw new Error(`Failed to load locale: ${locale}`);
  }
  return res.json();
}

export function getLocale() {
  return currentLocale;
}

export function isRtl() {
  return RTL.has(currentLocale);
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
export function t(key, params) {
  const raw = messages[key] ?? fallbackMessages[key] ?? key;
  return params ? interpolate(raw, params) : raw;
}

export function onLocaleChange(listener) {
  localeChangeListeners.add(listener);
  return () => localeChangeListeners.delete(listener);
}

function notifyLocaleChange() {
  for (const listener of localeChangeListeners) {
    try {
      listener(currentLocale);
    } catch (err) {
      console.warn("[i18n] localechange listener failed:", err);
    }
  }
}

export function applyDomI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key && "placeholder" in el) el.placeholder = t(key);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = t(key);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria-label");
    if (key) el.setAttribute("aria-label", t(key));
  });
  document.title = t("app.title");
}

function applyDocumentLocale(locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL.has(locale) ? "rtl" : "ltr";
  document.body.classList.toggle("locale-ar", locale === "ar");
}

export async function setLocale(locale, { persist = true } = {}) {
  const next = SUPPORTED.includes(locale) ? locale : FALLBACK;
  if (next === currentLocale && Object.keys(messages).length > 0) {
    applyDocumentLocale(next);
    applyDomI18n();
    return next;
  }

  const loaded = await loadMessages(next);
  messages = loaded;
  skillCatalog = await loadSkillCatalog(next);
  if (next !== FALLBACK && Object.keys(fallbackMessages).length === 0) {
    fallbackMessages = await loadMessages(FALLBACK);
  }
  if (next !== FALLBACK && Object.keys(skillCatalog).length === 0) {
    const fbSkills = await loadSkillCatalog(FALLBACK);
    if (Object.keys(fbSkills).length > 0) skillCatalog = fbSkills;
  }
  currentLocale = next;
  applyDocumentLocale(next);
  applyDomI18n();

  if (persist && window.assistantClient?.setLocale) {
    await window.assistantClient.setLocale(next);
  }

  notifyLocaleChange();
  return next;
}

export async function initI18n() {
  fallbackMessages = await loadMessages(FALLBACK);
  const fbSkills = await loadSkillCatalog(FALLBACK);
  if (Object.keys(fbSkills).length > 0) skillCatalog = fbSkills;
  let initial = FALLBACK;
  try {
    const data = await window.assistantClient?.getLocale?.();
    if (data?.ok && SUPPORTED.includes(data.locale)) {
      initial = data.locale;
    }
  } catch {
    // use fallback
  }
  await setLocale(initial, { persist: false });
}

/** Translate preset/mode labels by stable id. */
export function tModel(preset) {
  if (!preset?.id) return preset?.label || "";
  const key = `model.${preset.id}.label`;
  const translated = t(key);
  return translated === key ? preset.label : translated;
}

export function tModelDesc(preset) {
  if (!preset?.id) return preset?.description || "";
  const key = `model.${preset.id}.desc`;
  const translated = t(key);
  return translated === key ? preset.description || "" : translated;
}

export function tPermission(mode) {
  if (!mode?.id) return mode?.label || "";
  const key = `permission.${mode.id}.label`;
  const translated = t(key);
  return translated === key ? mode.label : translated;
}

export function tPermissionDesc(mode) {
  if (!mode?.id) return mode?.description || "";
  const key = `permission.${mode.id}.desc`;
  const translated = t(key);
  return translated === key ? mode.description || "" : translated;
}

export function tSearchProvider(provider) {
  if (!provider?.id) return provider?.label || "";
  const key = `search.provider.${provider.id}.label`;
  const translated = t(key);
  return translated === key ? provider.label : translated;
}

export function tSearchProviderDesc(provider) {
  if (!provider?.id) return provider?.description || "";
  const key = `search.provider.${provider.id}.desc`;
  const translated = t(key);
  return translated === key ? provider.description || "" : translated;
}

export function tSkillCategory(categoryId) {
  const key = `skills.category.${categoryId}`;
  const translated = t(key);
  return translated === key ? categoryId : translated;
}

function resolveSkillField(skill, field) {
  if (!skill?.id) return skill?.[field] || "";
  const entry = skillCatalog[skill.id];
  const fromCatalog = entry?.[field];
  if (fromCatalog) return fromCatalog;
  return skill[field] || "";
}

export function tSkillName(skill) {
  return resolveSkillField(skill, "name");
}

export function tSkillDesc(skill) {
  return resolveSkillField(skill, "description");
}

export function skillErrorMessage(error, detail) {
  if (error === "NETWORK" && detail) {
    const mapped = t("errors.NETWORK_DETAIL");
    if (mapped !== "errors.NETWORK_DETAIL") return mapped;
    return detail;
  }
  if (error === "INVALID_MANIFEST" && detail) {
    const mapped = t("errors.INVALID_MANIFEST");
    if (mapped !== "errors.INVALID_MANIFEST") return detail ? `${mapped} ${detail}` : mapped;
  }
  const key = `errors.${error}`;
  const mapped = t(key);
  return mapped === key ? detail || t("errors.GENERIC") : mapped;
}

export function fileErrorMessage(error, fileName) {
  const key = `fileErrors.${error}`;
  const base = t(key);
  const msg = base === key ? t("fileErrors.GENERIC", { error }) : base;
  return fileName ? t("fileErrors.WITH_NAME", { message: msg, name: fileName }) : msg;
}
