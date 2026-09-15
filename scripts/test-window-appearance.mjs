#!/usr/bin/env node
// A window must never show a bare rectangle in the WRONG theme. Both windows
// were hard-coded to the dark #0f1119 while the app defaults to light, and both
// were created already visible, so every pre-paint moment (creation, reload,
// slow boot, failed load) looked like a crash — the 2026-09-15 "黑屏" report.
// [gate: im-detached-window]
// Run: node scripts/test-window-appearance.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { windowBackgroundColor, rememberThemeMode, DARK_BODY, LIGHT_BODY } = require("../src/main/window-appearance.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

check("the pre-paint colour is exactly the theme's --bg-body, for every mode", () => {
  const css = fs.readFileSync(new URL("../src/renderer/styles/base.css", import.meta.url), "utf8");
  const dark = css.match(/:root\s*\{[\s\S]*?--bg-body:\s*(#[0-9a-f]{3,8})/i)?.[1];
  const light = css.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?--bg-body:\s*(#[0-9a-f]{3,8})/i)?.[1];
  assert.equal(dark?.toLowerCase(), DARK_BODY, "dark body colour drifted from the stylesheet");
  assert.equal(light?.toLowerCase(), LIGHT_BODY, "light body colour drifted from the stylesheet");
  assert.equal(windowBackgroundColor({ mode: "light" }), LIGHT_BODY);
  assert.equal(windowBackgroundColor({ mode: "dark" }), DARK_BODY);
  assert.equal(windowBackgroundColor({ mode: "system", prefersDark: false }), LIGHT_BODY);
  assert.equal(windowBackgroundColor({ mode: "system", prefersDark: true }), DARK_BODY);
  assert.equal(windowBackgroundColor({ mode: "nonsense", prefersDark: false }), LIGHT_BODY, "an unknown mode follows the OS");
});

check("no window hard-codes a background colour any more", () => {
  for (const file of ["../src/main.js", "../src/main/collaboration-window.js"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /backgroundColor:\s*"#0f1119"/, `${file} still pins the old dark navy`);
    assert.match(src, /windowBackgroundColor\(\)/, `${file} must resolve the colour from the theme`);
    assert.match(src, /show: false/, `${file} must not appear before it has painted`);
    assert.match(src, /showWhenPainted\(/, `${file} must reveal on first paint`);
  }
});

check("the reveal always happens: on paint, on load, on failure, and as a last resort on a timer", () => {
  const src = fs.readFileSync(new URL("../src/main/window-appearance.js", import.meta.url), "utf8");
  for (const hook of ["ready-to-show", "did-finish-load", "did-fail-load", "setTimeout"]) {
    assert.ok(src.includes(hook), `missing reveal path: ${hook}`);
  }
  const { showWhenPainted } = require("../src/main/window-appearance.js");
  const w = fakeWindow();
  showWhenPainted(w.win, { fallbackMs: 0, blankAfterMs: 0 });
  w.emit("ready-to-show"); w.emit("did-finish-load"); w.emit("ready-to-show");
  assert.equal(w.shown, 1, "the window is shown exactly once, whichever signal arrives first");
  assert.equal(w.loaded.length, 0, "a page that loaded is never replaced");
});

check("a window that cannot paint EXPLAINS itself instead of staying a blank rectangle", () => {
  const { showWhenPainted } = require("../src/main/window-appearance.js");
  // 1. the load failed
  const failed = fakeWindow();
  const reports = [];
  showWhenPainted(failed.win, { fallbackMs: 0, blankAfterMs: 0, locale: "zh-CN", onFailed: (info) => reports.push(info) });
  failed.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///x", true);
  assert.equal(failed.shown, 1, "a failed load still reveals the window");
  assert.equal(failed.loaded.length, 1, "…and loads an explanation into it");
  assert.match(decodeURIComponent(failed.loaded[0]), /这个窗口没能加载出来/);
  assert.match(decodeURIComponent(failed.loaded[0]), /ERR_FILE_NOT_FOUND/, "the cause is shown, not hidden");
  assert.deepEqual(reports.map((r) => r.reason), ["load_failed"]);
  failed.emit("did-fail-load", {}, -6, "again", "file:///y", true);
  assert.equal(failed.loaded.length, 1, "explained once");
  // 2. a sub-frame failure is not the page failing
  const sub = fakeWindow();
  showWhenPainted(sub.win, { fallbackMs: 0, blankAfterMs: 0 });
  sub.emit("did-fail-load", {}, -6, "sub", "file:///z", false);
  assert.equal(sub.loaded.length, 0);
  // 3. the renderer crashed
  const crashed = fakeWindow();
  showWhenPainted(crashed.win, { fallbackMs: 0, blankAfterMs: 0, locale: "en" });
  crashed.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
  assert.match(decodeURIComponent(crashed.loaded[0]), /could not load/i);
  assert.match(decodeURIComponent(crashed.loaded[0]), /crashed/);
  // 4. the fallback page failing must not loop
  const looping = fakeWindow();
  showWhenPainted(looping.win, { fallbackMs: 0, blankAfterMs: 0 });
  looping.emit("did-fail-load", {}, -6, "x", "data:text/html,boom", true);
  assert.equal(looping.loaded.length, 0, "a failing fallback is not replaced by another fallback");
  assert.equal(looping.shown, 1, "but the window is still revealed");
});

check("an explicit theme choice is mirrored for the next window; junk is refused", () => {
  assert.equal(rememberThemeMode("nonsense"), false);
  assert.equal(rememberThemeMode(""), false);
  assert.equal(rememberThemeMode(null), false);
  const preload = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
  assert.match(preload, /setThemeMode: \(mode\) => ipcRenderer\.invoke\("app:set-theme-mode", mode\)/);
  const handlers = fs.readFileSync(new URL("../src/main/ipc-handlers.js", import.meta.url), "utf8");
  assert.match(handlers, /ipcMain\.handle\("app:set-theme-mode"/);
  const settings = fs.readFileSync(new URL("../src/renderer/modules/theme-settings.js", import.meta.url), "utf8");
  assert.match(settings, /setThemeMode\?\.\(normalized\)/, "the renderer must tell main when the user picks a theme");
});

check("the fallback page is self-contained, escaped, and localized", () => {
  const { buildBlankFallbackHtml } = require("../src/main/window-blank-guard.js");
  const html = buildBlankFallbackHtml({ reason: "load_failed", detail: '<img src=x onerror=alert(1)>', locale: "zh-CN" });
  assert.doesNotMatch(html, /<img src=x/, "the detail is escaped, never injected");
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /https?:\/\//, "no network dependency");
  assert.doesNotMatch(html, /<script\b/, "no script tag beyond the inline reload handler");
  for (const locale of ["zh-CN", "en", "ar"]) {
    const page = buildBlankFallbackHtml({ locale });
    assert.ok(page.includes("<title>"), locale);
    assert.ok(page.length > 400, locale);
  }
  assert.match(buildBlankFallbackHtml({ locale: "ar" }), /dir="rtl"/);
  assert.match(buildBlankFallbackHtml({ locale: "en" }), /dir="ltr"/);
  assert.match(buildBlankFallbackHtml({ dark: true }), /#121418/);
  assert.match(buildBlankFallbackHtml({ dark: false }), /#f8f9fb/);
});

console.log(`\n${checks} checks passed (window appearance)`);

function fakeWindow() {
  const handlers = new Map();
  const state = { shown: 0, loaded: [] };
  const add = (event, fn) => handlers.set(event, [...(handlers.get(event) || []), fn]);
  state.win = {
    isDestroyed: () => false,
    show() { state.shown += 1; },
    once: add,
    webContents: {
      once: add,
      on: add,
      loadURL: (url) => { state.loaded.push(url); return Promise.resolve(); },
    },
  };
  state.emit = (event, ...args) => { for (const fn of handlers.get(event) || []) fn(...args); };
  return state;
}
