/**
 * Appearance theme state.
 *
 * The renderer owns theme because it is pure presentation state. CSS consumes
 * only the resolved semantic theme on documentElement.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

const THEME_STORAGE_KEY = "lily.themeMode";
const THEME_MODES = new Set(["system", "dark", "light"]);

let mediaQuery = null;

function normalizeThemeMode(value) {
  return THEME_MODES.has(value) ? value : "system";
}

function getThemeMode() {
  try {
    return normalizeThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function applyThemeMode(mode) {
  const normalized = normalizeThemeMode(mode);
  const resolved = resolveTheme(normalized);
  const root = document.documentElement;
  root.dataset.themeMode = normalized;
  root.dataset.theme = resolved;
  root.classList.toggle("light", resolved === "light");
  root.classList.toggle("dark", resolved === "dark");
}

function saveThemeMode(mode) {
  const normalized = normalizeThemeMode(mode);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Theme still applies for this runtime even if persistence is unavailable.
  }
  applyThemeMode(normalized);
  return normalized;
}

export function refreshThemeSelect() {
  const select = $("themeModeSelect");
  const mode = getThemeMode();
  applyThemeMode(mode);
  if (select) select.value = mode;
}

export function initThemeSettings() {
  refreshThemeSelect();

  $("themeModeSelect")?.addEventListener("change", (event) => {
    const mode = saveThemeMode(event.target.value);
    event.target.value = mode;
    showToast(t("toast.themeSwitched"), "success");
  });

  mediaQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;
  mediaQuery?.addEventListener?.("change", () => {
    if (getThemeMode() === "system") applyThemeMode("system");
  });
}
