"use strict";

/**
 * The colour a window paints BEFORE its renderer has drawn anything.
 *
 * Both windows were hard-coded to `#0f1119` — a dark navy from an earlier,
 * dark-only design. The app now defaults to the light theme, so every moment
 * before first paint (window creation, a reload, a slow boot, a failed load)
 * showed a large dark rectangle that reads as a crash: the 2026-09-15 "黑屏"
 * report. The value must track the theme the renderer is about to apply.
 *
 * The renderer's own choice lives in localStorage (see the bootstrap in
 * index.html), which the main process cannot read at window-creation time, so
 * it is mirrored into app-preferences.json. Absent a mirror, the OS preference
 * is the same input the renderer's "system" default uses.
 */

const DARK_BODY = "#121418"; // :root            --bg-body
const LIGHT_BODY = "#f8f9fb"; // :root[data-theme="light"] --bg-body

function storedThemeMode() {
  try {
    const fs = require("node:fs");
    const { userDataPath } = require("./config");
    const file = userDataPath("app-preferences.json");
    if (!fs.existsSync(file)) return "";
    const mode = JSON.parse(fs.readFileSync(file, "utf8"))?.themeMode;
    return ["light", "dark", "system"].includes(mode) ? mode : "";
  } catch {
    return "";
  }
}

function systemPrefersDark() {
  try {
    return require("electron").nativeTheme?.shouldUseDarkColors !== false;
  } catch {
    return true;
  }
}

/** @returns {string} hex colour matching the theme the renderer will apply. */
function windowBackgroundColor({ mode = storedThemeMode(), prefersDark = null } = {}) {
  if (mode === "light") return LIGHT_BODY;
  if (mode === "dark") return DARK_BODY;
  const dark = prefersDark === null ? systemPrefersDark() : Boolean(prefersDark);
  return dark ? DARK_BODY : LIGHT_BODY;
}

/**
 * Show the window only once it has painted, so a slow or failed boot never
 * leaves a bare coloured rectangle on screen. Always resolves: a window that
 * never paints is shown anyway after `fallbackMs` so it can never be invisible.
 */
function showWhenPainted(win, { fallbackMs = 4000, blankAfterMs = 12000, onFailed = null, locale = null } = {}) {
  if (!win || win.isDestroyed?.()) return;
  let shown = false;
  let painted = false;
  let explained = false;
  const reveal = () => {
    if (shown || !win || win.isDestroyed?.()) return;
    shown = true;
    try { win.show(); } catch { /* the window may be gone */ }
  };
  // Whatever went wrong, the window says so instead of sitting there blank.
  const explain = (reason, detail) => {
    if (explained || painted || !win || win.isDestroyed?.()) return;
    explained = true;
    reveal();
    try {
      const { fallbackDataUrl } = require("./window-blank-guard");
      const mode = storedThemeMode();
      const dark = mode === "dark" || (mode !== "light" && systemPrefersDark());
      const resolved = locale || (() => {
        try { return require("./locale-settings").getLocale() || "zh-CN"; } catch { return "zh-CN"; }
      })();
      void win.webContents?.loadURL?.(fallbackDataUrl({ reason, detail, locale: resolved, dark }));
    } catch { /* the bare background is still better than a hang */ }
    try { onFailed?.({ reason, detail }); } catch { /* reporting is best effort */ }
  };
  try {
    win.once("ready-to-show", reveal);
    win.webContents?.once?.("paint", () => { painted = true; });
    win.webContents?.once?.("did-finish-load", () => { painted = true; reveal(); });
    win.webContents?.on?.("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (!isMainFrame) return;
      // A data: fallback that itself fails must not loop.
      if (String(url || "").startsWith("data:")) { reveal(); return; }
      explain("load_failed", [errorDescription, errorCode, url].filter(Boolean).join(" · "));
    });
    win.webContents?.on?.("render-process-gone", (_event, details) => {
      painted = false;
      explain("crashed", [details?.reason, details?.exitCode].filter((v) => v !== undefined && v !== null).join(" · "));
    });
  } catch { /* fall through to the timers */ }
  const revealTimer = setTimeout(reveal, Math.max(0, fallbackMs));
  revealTimer?.unref?.();
  if (blankAfterMs > 0) {
    const blankTimer = setTimeout(() => explain("never_painted", ""), blankAfterMs);
    blankTimer?.unref?.();
  }
}

/**
 * Mirror the renderer's theme choice so the NEXT window creation (and the next
 * app start) paints the right colour before any renderer runs.
 * @returns {boolean} whether the mirror was written.
 */
function rememberThemeMode(mode) {
  if (!["light", "dark", "system"].includes(mode)) return false;
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const { userDataPath } = require("./config");
    const file = userDataPath("app-preferences.json");
    let data = {};
    try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { data = {}; }
    if (data.themeMode === mode) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...data, themeMode: mode }, null, 2), "utf8");
    return true;
  } catch {
    return false; // the OS preference remains the fallback
  }
}

module.exports = { windowBackgroundColor, showWhenPainted, rememberThemeMode, storedThemeMode, DARK_BODY, LIGHT_BODY };
