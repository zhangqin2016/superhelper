#!/usr/bin/env node
// A renderer process that ends while the app is running is brought back by
// the window itself; the explanation page is for a renderer that keeps dying,
// and its button loads the app again rather than the explanation.
//
// Field report 2026-09-20: "This window could not load · killed · 15" after
// hours of use, nothing the customer did. Before this the main window stayed
// on the explanation for good (its Reload reloaded the data: page), the exit
// was logged only under LILY_DEBUG_RENDERER, and nothing reached diagnostics.
// [gate: renderer-process-recovery]
// Run: node scripts/test-renderer-process-recovery.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { showWhenPainted } = require("../src/main/window-appearance.js");
const { RECOVER_URL, buildBlankFallbackHtml } = require("../src/main/window-blank-guard.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const APP = "file:///app/src/renderer/index.html";
function fakeWindow() {
  const handlers = new Map();
  const state = { shown: 0, loaded: [], url: "" };
  const add = (event, fn) => handlers.set(event, [...(handlers.get(event) || []), fn]);
  state.win = {
    isDestroyed: () => false,
    show() { state.shown += 1; },
    once: add,
    webContents: { once: add, on: add, getURL: () => state.url, loadURL: (url) => { state.loaded.push(url); state.url = url; return Promise.resolve(); } },
  };
  state.emit = (event, ...args) => { for (const fn of handlers.get(event) || []) fn(...args); };
  state.boot = () => { state.url = APP; state.emit("did-finish-load"); };
  return state;
}

await check("a running page whose renderer is killed is reloaded, not replaced by an explanation", () => {
  const w = fakeWindow();
  const gone = [];
  let clock = 1_000;
  showWhenPainted(w.win, { fallbackMs: 0, blankAfterMs: 0, role: "main", onGone: (info) => gone.push(info), now: () => clock, defer: (fn) => fn() });
  w.boot();
  w.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
  assert.deepEqual(w.loaded, [APP], "the app's own URL is loaded again");
  assert.deepEqual(gone, [{ reason: "killed", exitCode: 15, recovered: true, attempt: 1, role: "main" }], "and the exit is reported with its outcome");
  w.boot();
  clock += 10_000;
  w.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
  assert.deepEqual(w.loaded, [APP, APP], "a second exit inside the window is still recovered");
  assert.equal(gone.at(-1).attempt, 2);
});

await check("a renderer that keeps dying gets the explanation, and its button loads the app again", () => {
  const w = fakeWindow();
  let clock = 1_000;
  const gone = [];
  showWhenPainted(w.win, { fallbackMs: 0, blankAfterMs: 0, role: "main", locale: "zh-CN", onGone: (info) => gone.push(info), now: () => clock, defer: (fn) => fn() });
  w.boot();
  for (let i = 0; i < 3; i += 1) { w.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 }); w.boot(); }
  assert.equal(w.loaded.filter((u) => u === APP).length, 2, "two recoveries per minute");
  const explanation = w.loaded.find((u) => u.startsWith("data:"));
  assert.ok(explanation, "the third exit is explained");
  assert.equal(gone.at(-1).recovered, false);
  const html = decodeURIComponent(explanation);
  assert.match(html, /killed · 15/, "the signal is shown");
  assert.match(html, /回到应用/, "the main window gets the main-window hint");
  assert.ok(!html.includes("回到主界面继续"), "…not the secondary-window one");
  assert.ok(html.includes(`location.href='${RECOVER_URL}'`), "the button navigates to the recover URL, never location.reload()");
  const prevented = [];
  w.emit("will-navigate", { preventDefault: () => prevented.push(1) }, RECOVER_URL);
  assert.equal(prevented.length, 1, "the navigation is intercepted");
  assert.equal(w.loaded.at(-1), APP, "and the app is loaded again");
  w.boot();
  clock += 1;
  w.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
  assert.equal(w.loaded.at(-1), APP, "a user-driven reload resets the budget");
});

await check("a budget window that has passed lets recovery happen again", () => {
  const w = fakeWindow();
  let clock = 0;
  showWhenPainted(w.win, { fallbackMs: 0, blankAfterMs: 0, now: () => clock, recoverWindowMs: 60_000, defer: (fn) => fn() });
  w.boot();
  w.emit("render-process-gone", {}, { reason: "oom" }); w.boot();
  w.emit("render-process-gone", {}, { reason: "oom" }); w.boot();
  clock = 61_000;
  w.emit("render-process-gone", {}, { reason: "oom" });
  assert.equal(w.loaded.filter((u) => u === APP).length, 3, "the old attempts have aged out");
  assert.equal(w.loaded.some((u) => u.startsWith("data:")), false);
});

await check("recovery never runs inside the render-process-gone handler itself", () => {
  const w = fakeWindow();
  showWhenPainted(w.win, { fallbackMs: 0, blankAfterMs: 0 });
  w.boot();
  w.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
  assert.deepEqual(w.loaded, [], "nothing is loaded synchronously — Electron traps on that");
  return new Promise((resolve) => setTimeout(() => { assert.deepEqual(w.loaded, [APP]); resolve(); }, 5));
});

await check("what is not recovered: a clean exit, a renderer that never painted, a window without a page", () => {
  const clean = fakeWindow();
  showWhenPainted(clean.win, { fallbackMs: 0, blankAfterMs: 0 });
  clean.boot();
  clean.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  assert.equal(clean.loaded.length, 1, "a clean exit is the app's own doing");
  assert.match(decodeURIComponent(clean.loaded[0]), /clean-exit/);
  const never = fakeWindow();
  showWhenPainted(never.win, { fallbackMs: 0, blankAfterMs: 0, locale: "en" });
  never.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
  assert.match(decodeURIComponent(never.loaded[0]), /could not load/i, "a crash before first paint is explained at once, as before");
});

await check("the secondary window keeps its own hint, and every locale has both", () => {
  for (const locale of ["zh-CN", "en", "ar"]) {
    const main = buildBlankFallbackHtml({ reason: "crashed", locale, role: "main" });
    const secondary = buildBlankFallbackHtml({ reason: "crashed", locale });
    assert.notEqual(main, secondary, `${locale}: the two roles read differently`);
    assert.ok(main.includes(RECOVER_URL) && secondary.includes(RECOVER_URL));
  }
});

await check("both windows report every renderer exit, always, to the log and to diagnostics", () => {
  const main = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  assert.match(main, /role: "main"/);
  assert.match(main, /onGone: \(info\) => require\("\.\/main\/renderer-process-gone"\)\.recordRendererGone\(info, \{ window: "main" \}\)/);
  const collab = fs.readFileSync(path.join(ROOT, "src/main/collaboration-window.js"), "utf8");
  assert.match(collab, /recordRendererGone\(info, \{ window: "collaboration" \}\)/);
  const { recordRendererGone } = require("../src/main/renderer-process-gone.js");
  const reports = [];
  const record = recordRendererGone({ reason: "killed", exitCode: 15, recovered: true, attempt: 1 }, { window: "main", report: () => (payload) => { reports.push(payload); return Promise.resolve({ ok: true }); } });
  assert.equal(record.reason, "killed");
  assert.equal(record.exitCode, 15);
  assert.equal(record.platform, process.platform);
  assert.ok(record.uptimeMs >= 0);
  return new Promise((resolve) => setImmediate(() => {
    assert.equal(reports.length, 1);
    assert.equal(reports[0].eventSubtype, "renderer_process_gone");
    assert.equal(reports[0].severity, "warning", "a recovered exit is a warning; an unrecovered one an error");
    assert.match(reports[0].summary, /renderer killed \(exit 15\) after \d+s in main; recovered/);
    assert.equal(reports[0].trace.exitCode, 15);
    resolve();
  }));
});
const failing = recordRendererGoneFailing();
function recordRendererGoneFailing() {
  const { recordRendererGone } = require("../src/main/renderer-process-gone.js");
  // A reporter that throws or rejects never affects the window.
  recordRendererGone({ reason: "crashed" }, { window: "main", report: () => () => Promise.reject(new Error("offline")) });
  recordRendererGone({ reason: "crashed" }, { window: "main", report: () => { throw new Error("no client"); } });
  return true;
}
assert.equal(failing, true);

console.log(`\n${checks} checks passed (renderer process recovery)`);
