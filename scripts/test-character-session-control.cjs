#!/usr/bin/env node
"use strict";

/**
 * Electron DOM tests for the conversation-level character control
 * (Character Worlds Phase 1, plan Task 9 step 2).
 *
 * Covers: toolbar icon button with tooltip/accessible name, popover focus
 * trapping + keyboard selection, import preview confirmation flow, conflict
 * reconciliation, no nested cards, and stable toolbar dimensions when labels
 * change length. The character-worlds IPC channels are mocked in main; the
 * control runs against the real index.html DOM and preload bridge.
 */

const electron = require("electron");
const { app, BrowserWindow, ipcMain } = electron;
const path = require("node:path");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error("test-character-session-control must run under Electron. Use: npx electron scripts/test-character-session-control.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
let win;

const hardTimeout = setTimeout(() => {
  console.error("test-character-session-control: timed out");
  try {
    win?.destroy?.();
  } catch {
    // Best effort test cleanup.
  }
  app.exit(1);
  process.exit(1);
}, Number(process.env.TEST_CHARACTER_CONTROL_TIMEOUT_MS || 120000));

function finish(code = app.exitCode || 0) {
  clearTimeout(hardTimeout);
  try {
    win?.destroy?.();
  } catch {
    // Best effort test cleanup.
  }
  app.exit(code);
  setTimeout(() => process.exit(code), 250).unref?.();
}

// --- Mock workspace shell ----------------------------------------------------
const rendererProjects = [
  {
    id: "project_alpha",
    name: "Alpha Workspace",
    path: "/tmp/Alpha Workspace",
    sessions: [
      {
        id: "session_alpha_recent",
        title: "Alpha recent discussion",
        createdAt: "2026-07-24T08:00:00.000Z",
        updatedAt: "2026-07-25T08:00:00.000Z",
      },
    ],
  },
];
const rendererActiveProjectId = "project_alpha";
const rendererActiveSessionId = "session_alpha_recent";

// --- Mock character-worlds backend -------------------------------------------
const cwCharacters = [
  {
    schemaVersion: 1,
    id: "char-night",
    ownerScope: "owner",
    displayName: "巡夜人",
    currentRevisionId: "rev-night-1",
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    archivedAt: null,
  },
  {
    schemaVersion: 1,
    id: "char-long",
    ownerScope: "owner",
    displayName: "夜游神·リラ——一个名字非常非常非常长以至於需要省略显示的角色名字",
    currentRevisionId: "rev-long-1",
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    archivedAt: null,
  },
];
const cwBindings = new Map();
let cwSetBehavior = "ok";
let cwPreviewBehavior = "card";
let cwCommitBehavior = "ok";
let cwGetBindingBehavior = "ok";
// Phase 2B update-available hint returned by the mock get-binding; a
// successful set-binding commit applies it, so the hint clears.
let cwGetBindingUpdates = null;
const cwSetCalls = [];
const cwCommitCalls = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nativeBinding(sessionId, bindingVersion = 0) {
  return {
    schemaVersion: 1,
    sessionId,
    mode: "native",
    bindingVersion,
    characterRevisionId: null,
    compatibilityProfile: null,
  };
}

ipcMain.handle("character:list", () => ({ ok: true, characters: cwCharacters }));
ipcMain.handle("session-character:get-binding", (_event, payload) => {
  if (cwGetBindingBehavior !== "ok") return { ok: false, error: cwGetBindingBehavior };
  const sessionId = payload?.sessionId || "";
  return { ok: true, binding: cwBindings.get(sessionId) || nativeBinding(sessionId), updates: cwGetBindingUpdates };
});
ipcMain.handle("session-character:set-binding", async (_event, payload) => {
  cwSetCalls.push(payload);
  const sessionId = payload?.sessionId || "";
  if (cwSetBehavior === "conflict") {
    const current = nativeBinding(sessionId, 3);
    cwBindings.set(sessionId, current);
    return { ok: false, error: "CHARACTER_BINDING_CONFLICT", currentBinding: current };
  }
  if (cwSetBehavior === "slow") await delay(250);
  const current = cwBindings.get(sessionId) || nativeBinding(sessionId);
  if (current.bindingVersion !== payload?.expectedBindingVersion) {
    return { ok: false, error: "CHARACTER_BINDING_CONFLICT", currentBinding: current };
  }
  const next = {
    schemaVersion: 1,
    sessionId,
    mode: payload?.mode === "character" ? "character" : "native",
    bindingVersion: current.bindingVersion + 1,
    characterRevisionId: payload?.mode === "character" ? payload?.characterRevisionId || null : null,
    compatibilityProfile: payload?.mode === "character" ? "lily-character-compat-1" : null,
  };
  cwBindings.set(sessionId, next);
  cwGetBindingUpdates = null; // a committed write applies any hinted update
  return { ok: true, binding: next };
});
ipcMain.handle("session-character:get-events", () => ({ ok: true, events: [], notices: [] }));
ipcMain.handle("character:import-preview", () => {
  if (cwPreviewBehavior === "notacard") {
    return { ok: false, error: "NOT_A_CHARACTER_CARD", fallback: "ordinary_attachment" };
  }
  if (cwPreviewBehavior === "card-duplicate") {
    return {
      ok: true,
      kind: "characterCard",
      previewToken: "e".repeat(64),
      expiresAt: Date.now() + 60000,
      format: "v2_json",
      container: "json",
      canonical: { schemaVersion: 1, name: "导入的抄写员" },
      compatibility: {
        supported: ["/name"],
        migrated: [],
        preservedInert: [],
        ignoredInvalid: [],
        rejectedExecutable: [],
        counts: { supported: 6, migrated: 0, preservedInert: 0, ignoredInvalid: 0, rejectedExecutable: 0 },
        level: "lossless_data",
        truncation: null,
        warnings: [],
      },
      // An equivalent character already exists: the commit must opt into a copy.
      duplicates: { exact: null, canonical: { entityId: "char-night", revisionId: "rev-night-1" } },
    };
  }
  if (cwPreviewBehavior !== "card") {
    return { ok: false, error: cwPreviewBehavior };
  }
  return {
    ok: true,
    kind: "characterCard",
    previewToken: "d".repeat(64),
    expiresAt: Date.now() + 60000,
    format: "v2_json",
    container: "json",
    canonical: { schemaVersion: 1, name: "导入的抄写员" },
    compatibility: {
      supported: ["/name", "/description"],
      migrated: [],
      preservedInert: ["/data/extensions/world"],
      ignoredInvalid: [],
      rejectedExecutable: ["/data/extensions/script"],
      counts: { supported: 8, migrated: 0, preservedInert: 2, ignoredInvalid: 0, rejectedExecutable: 1 },
      level: "safe_behavior",
      truncation: null,
      warnings: [],
    },
    duplicates: { exact: null, canonical: null },
  };
});
ipcMain.handle("character:import-commit", async (_event, payload) => {
  cwCommitCalls.push(payload);
  if (cwCommitBehavior === "slow") await delay(250);
  const entity = {
    schemaVersion: 1,
    id: "char-imported",
    ownerScope: "owner",
    displayName: "导入的抄写员",
    currentRevisionId: "rev-imported-1",
    createdAt: "2026-07-25T08:00:00.000Z",
    updatedAt: "2026-07-25T08:00:00.000Z",
    archivedAt: null,
  };
  if (!cwCharacters.some((c) => c.id === entity.id)) cwCharacters.push(entity);
  return {
    ok: true,
    entity,
    revision: { id: "rev-imported-1" },
    duplicate: { kind: "none", reused: false },
  };
});

// --- Minimal shell mocks so app.js init completes -----------------------------
ipcMain.handle("app:get-locale", () => ({ ok: true, locale: "zh-CN" }));
ipcMain.handle("app:get-version", () => ({ ok: true, version: "0.0.0-test" }));
ipcMain.handle("app:get-edition", () => ({ ok: true, id: "domestic", features: { account: true } }));
ipcMain.handle("app:get-icon-url", () => ({ ok: true, url: "" }));
ipcMain.handle("account:status", () => ({ ok: true, loggedIn: false, user: null, entitlements: {} }));
ipcMain.handle("mail-accounts:list", () => ({ ok: true, accounts: [] }));
ipcMain.handle("models:list", () => ({ ok: true, presets: [], activePresetId: "" }));
ipcMain.handle("permissions:list", () => ({ ok: true, modes: [], currentMode: "" }));
ipcMain.handle("search:list", () => ({ ok: true, providers: [], activeProviderId: "" }));
ipcMain.handle("skills:list", () => ({ ok: true, groups: [], skills: [] }));
ipcMain.handle("skills:check-updates", () => ({ ok: true, updates: [] }));
ipcMain.handle("skills:get-preset-guide", () => ({ ok: true, guide: null }));
ipcMain.handle("license:status", () => ({ ok: true, status: "active", source: "test" }));
ipcMain.handle("updates:get-settings", () => ({ ok: true, settings: { autoCheck: true } }));
ipcMain.handle("updates:get-state", () => ({ ok: true, state: { status: "idle" } }));
ipcMain.handle("updates:kick-check", () => ({ ok: true, state: { status: "idle" } }));
ipcMain.handle("scheduled-tasks:list", () => ({ ok: true, tasks: [] }));
ipcMain.handle("session:get-conversation", () => ({ ok: true, conversation: [], total: 0, hasMore: false, nextBefore: 0 }));
ipcMain.handle("session:switch", (_event, sessionId) => ({ ok: true, conversation: [], session: { id: sessionId, title: "Alpha chat" } }));
ipcMain.handle("state:full", () => ({
  projects: rendererProjects,
  activeProjectId: rendererActiveProjectId,
  activeSessionId: rendererActiveSessionId,
  conversation: [],
  runtime: { sessions: {} },
  settings: {},
}));
ipcMain.handle("apps:catalog", () => ({ ok: true, json: { apps: [] } }));

async function run(label, source) {
  try {
    const value = await win.webContents.executeJavaScript(source);
    console.log(`${label}: ok${typeof value === "string" && value ? ` — ${value}` : ""}`);
    return value;
  } catch (error) {
    console.error(`${label}: FAIL ${error?.message || error}`);
    try {
      const debug = await win.webContents.executeJavaScript(`(async () => {
        const mod = await import("./modules/character-session-control.js");
        const notice = document.getElementById("characterPopoverNotice");
        return JSON.stringify({
          popoverHidden: document.getElementById("characterPopover")?.hidden,
          noticeHidden: notice?.hidden,
          noticeText: notice?.textContent || "",
          live: document.getElementById("characterControlLive")?.textContent || "",
          state: mod.getCharacterControlState(),
        });
      })()`);
      console.error(`${label}: debug ${debug}`);
    } catch {
      // Best effort diagnostics.
    }
    app.exitCode = 1;
    return null;
  }
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "src/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on("console-message", (_e, _level, msg) => {
    if (String(msg).includes("does not provide an export")) {
      console.error("CONSOLE:", msg);
    }
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await new Promise((r) => setTimeout(r, 1800));

  // 1. The module loads and exposes the pure reducer + controller.
  await run("module-import", `(async () => {
    const mod = await import("./modules/character-session-control.js");
    for (const name of ["initialCharacterControlState", "reduceCharacterControl", "initCharacterSessionControl"]) {
      if (typeof mod[name] !== "function") throw new Error("missing export " + name);
    }
    return "exports present";
  })()`);

  // 2. Toolbar icon button: tooltip, accessible name, Lucide icon, popover wiring.
  await run("toolbar-button", `(() => {
    const btn = document.getElementById("sessionCharacterBtn");
    if (!btn) throw new Error("character toolbar button missing");
    if (btn.hidden) throw new Error("character button should be visible when the facade exists");
    if (!btn.title || !btn.getAttribute("aria-label")) throw new Error("button needs tooltip + accessible name");
    if (btn.getAttribute("data-i18n-title") !== "character.buttonTitle") throw new Error("button tooltip must be localized");
    if (btn.getAttribute("aria-haspopup") !== "dialog") throw new Error("button must announce its popover");
    if (!btn.querySelector("svg")) throw new Error("button must render the UserRound icon");
    return btn.title;
  })()`);

  // 3. Popover opens, focus moves inside, options render.
  await run("popover-open", `(async () => {
    const btn = document.getElementById("sessionCharacterBtn");
    const popover = document.getElementById("characterPopover");
    if (!popover || !popover.hidden) throw new Error("popover should start hidden");
    btn.click();
    await new Promise((r) => setTimeout(r, 120));
    if (popover.hidden) throw new Error("popover should open on click");
    if (btn.getAttribute("aria-expanded") !== "true") throw new Error("aria-expanded should track the popover");
    if (!popover.contains(document.activeElement)) throw new Error("focus must move into the popover");
    const native = popover.querySelector('[data-character-mode="native"]');
    if (!native || !/Lily/.test(native.textContent)) throw new Error("native Lily option missing");
    const items = popover.querySelectorAll('[data-character-revision-id]');
    if (items.length < 2) throw new Error("recent local characters should be listed, got " + items.length);
    const importBtn = document.getElementById("characterImportBtn");
    if (!importBtn || !importBtn.textContent.trim()) throw new Error("import entry missing");
    const manageBtn = document.getElementById("characterManageBtn");
    if (!manageBtn || manageBtn.disabled) throw new Error("manage library must be enabled in Phase 2B");
    if (/Phase 2|第二/.test(manageBtn.textContent)) throw new Error("Phase 2 placeholder label must be gone");
    const createBtn = document.getElementById("characterCreateBtn");
    if (!createBtn || !createBtn.textContent.trim()) throw new Error("direct create entry missing");
    if (popover.style.insetInlineStart !== "8px") throw new Error("popover must anchor to inline-start for RTL, got " + popover.style.insetInlineStart);
    const notice = document.getElementById("characterPopoverNotice");
    if (notice && notice.getAttribute("role")) throw new Error("notices must use the single live region, not a second role=status");
    return "items=" + items.length;
  })()`);

  // 4. Keyboard navigation + focus trapping.
  await run("popover-keyboard", `(async () => {
    const popover = document.getElementById("characterPopover");
    const focusables = () => [...popover.querySelectorAll("button:not([disabled])")].filter((b) => !b.closest("[hidden]"));
    const items = focusables();
    if (items.length < 3) throw new Error("need several focusable rows, got " + items.length);
    const press = (key, options = {}) => popover.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
    items[0].focus();
    press("ArrowDown");
    if (document.activeElement !== items[1]) throw new Error("ArrowDown should move to the next row");
    press("ArrowUp");
    if (document.activeElement !== items[0]) throw new Error("ArrowUp should move back");
    press("End");
    if (document.activeElement !== items[items.length - 1]) throw new Error("End should jump to the last row");
    press("Home");
    if (document.activeElement !== items[0]) throw new Error("Home should jump to the first row");
    // Focus trap: Tab on the last row wraps to the first, Shift+Tab on the first wraps to the last.
    items[items.length - 1].focus();
    press("Tab");
    if (document.activeElement !== items[0]) throw new Error("Tab should wrap inside the popover");
    press("Tab", { shiftKey: true });
    if (document.activeElement !== items[items.length - 1]) throw new Error("Shift+Tab should wrap inside the popover");
    if (!popover.contains(document.activeElement)) throw new Error("focus must never leave the open popover");
    return "trap verified over " + items.length + " rows";
  })()`);

  // 5. Select a character: optimistic swatch + name, CAS call, aria-live status.
  await run("select-character", `(async () => {
    const popover = document.getElementById("characterPopover");
    const btn = document.getElementById("sessionCharacterBtn");
    const row = popover.querySelector('[data-character-revision-id="rev-night-1"]');
    if (!row) throw new Error("character row missing");
    row.click();
    await new Promise((r) => setTimeout(r, 150));
    const label = btn.querySelector(".composer-character-btn-label");
    if (!label || !label.textContent.includes("巡夜人")) throw new Error("button should show the bound name");
    if (label.title !== "巡夜人") throw new Error("full name must be available via title");
    const swatch = btn.querySelector(".composer-character-btn-swatch");
    if (!swatch || swatch.hidden) throw new Error("bound state shows the avatar swatch");
    const live = document.getElementById("characterControlLive");
    if (!live || !live.textContent.includes("巡夜人")) throw new Error("selection must be announced via aria-live");
    return "bound 巡夜人";
  })()`);

  // 5b. The optimistic selection used a compare-and-swap version.
  {
    const last = cwSetCalls.at(-1);
    if (!last || last.mode !== "character" || last.characterRevisionId !== "rev-night-1") {
      console.error("set-binding-cas: FAIL last call was " + JSON.stringify(last));
      app.exitCode = 1;
    } else if (typeof last.expectedBindingVersion !== "number") {
      console.error("set-binding-cas: FAIL expectedBindingVersion missing");
      app.exitCode = 1;
    } else {
      console.log("set-binding-cas: ok");
    }
  }

  // 6. Layout stability: switch to a very long name, toolbar dimensions hold.
  await run("layout-stable", `(async () => {
    const btn = document.getElementById("sessionCharacterBtn");
    const label = btn.querySelector(".composer-character-btn-label");
    const before = { w: btn.offsetWidth, h: btn.offsetHeight, text: label.textContent };
    document.getElementById("sessionCharacterBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const popover = document.getElementById("characterPopover");
    const row = popover.querySelector('[data-character-revision-id="rev-long-1"]');
    row.click();
    await new Promise((r) => setTimeout(r, 150));
    const after = { w: btn.offsetWidth, h: btn.offsetHeight, text: label.textContent };
    if (before.text === after.text) throw new Error("name should have changed");
    if (before.w !== after.w || before.h !== after.h) {
      throw new Error("toolbar button shifted: " + JSON.stringify({ before, after }));
    }
    const btnWidth = parseFloat(getComputedStyle(btn).width);
    if (!(btnWidth > 30)) {
      throw new Error("bound button must grow beyond the 30px icon-button pin, got " + btnWidth);
    }
    const style = getComputedStyle(label);
    if (style.textOverflow !== "ellipsis" || style.overflow !== "hidden" || style.whiteSpace !== "nowrap") {
      throw new Error("long names must ellipsize: " + style.textOverflow + "/" + style.overflow + "/" + style.whiteSpace);
    }
    if (!/px$/.test(style.maxWidth) && !/px$/.test(style.width)) throw new Error("label needs a fixed width constraint: " + style.width + "/" + style.maxWidth);
    if (!label.title || label.title.length < 20) throw new Error("full long name must remain available via title");
    return "stable at " + after.w + "x" + after.h;
  })()`);

  // 6b. The hidden attribute must win over author display:flex/grid styles.
  await run("hidden-guards", `(async () => {
    const btn = document.getElementById("sessionCharacterBtn");
    const icon = btn.querySelector(".composer-character-btn-icon");
    const swatch = btn.querySelector(".composer-character-btn-swatch");
    // Bound state (long name selected above): icon hidden, swatch shown.
    if (!icon.hidden || getComputedStyle(icon).display !== "none") {
      throw new Error("bound state must hide the unselected icon");
    }
    if (swatch.hidden || getComputedStyle(swatch).display === "none") {
      throw new Error("bound state must show the avatar swatch");
    }
    // The no-facade fail-open hide must actually remove the button.
    btn.hidden = true;
    const display = getComputedStyle(btn).display;
    btn.hidden = false;
    if (display !== "none") throw new Error("[hidden] must beat author display styles, got " + display);
    return "guards hold";
  })()`);

  // 6c. Update-available (Phase 2B): the hint shows in the popover WITHOUT
  // changing the pinned snapshot; apply re-reads the binding and issues
  // set-binding with the current expectedBindingVersion; the hint clears.
  {
    cwBindings.set("session_alpha_recent", {
      schemaVersion: 1,
      sessionId: "session_alpha_recent",
      mode: "character",
      bindingVersion: 4,
      characterRevisionId: "rev-night-1",
      compatibilityProfile: "lily-character-compat-1",
    });
    cwGetBindingUpdates = { character: { currentRevisionId: "rev-night-2" } };
    const callsBefore = cwSetCalls.length;
    await run("update-available", `(async () => {
      const mod = await import("./modules/character-session-control.js");
      const popover = document.getElementById("characterPopover");
      if (!popover.hidden) document.getElementById("sessionCharacterBtn").click();
      await new Promise((r) => setTimeout(r, 60));
      document.getElementById("sessionCharacterBtn").click();
      await new Promise((r) => setTimeout(r, 200));
      if (popover.hidden) throw new Error("popover should be open");
      const row = document.getElementById("characterUpdateRow");
      if (!row || row.hidden) throw new Error("update-available row should show");
      if (!row.textContent.includes("新版本")) throw new Error("row must be localized, got " + row.textContent);
      const applyBtn = row.querySelector('[data-action="apply-update"]');
      if (!applyBtn) throw new Error("explicit apply action missing");
      // The hint must not change the pinned snapshot.
      const state = mod.getCharacterControlState();
      if (state.characterRevisionId !== "rev-night-1" || state.bindingVersion !== 4) {
        throw new Error("hint changed the pinned snapshot: " + JSON.stringify(state));
      }
      applyBtn.click();
      await new Promise((r) => setTimeout(r, 350));
      if (!row.hidden) throw new Error("indicator must clear after apply");
      const settled = mod.getCharacterControlState();
      if (settled.characterRevisionId !== "rev-night-2" || settled.bindingVersion !== 5) {
        throw new Error("apply should pin the current revision: " + JSON.stringify(settled));
      }
      document.getElementById("characterPopoverClose").click(); // restore the closed state
      return "applied rev-night-2";
    })()`);
    const applyCall = cwSetCalls.at(-1);
    if (cwSetCalls.length !== callsBefore + 1 || !applyCall
      || applyCall.expectedBindingVersion !== 4
      || applyCall.characterRevisionId !== "rev-night-2"
      || applyCall.mode !== "character") {
      console.error("update-apply-cas: FAIL " + JSON.stringify(applyCall));
      app.exitCode = 1;
    } else {
      console.log("update-apply-cas: ok");
    }
  }

  // 7. Conflict reconciliation: stale CAS -> reconcile from currentBinding.
  {
    cwSetBehavior = "conflict";
    await run("conflict-reconcile", `(async () => {
      document.getElementById("sessionCharacterBtn").click();
      await new Promise((r) => setTimeout(r, 120));
      const popover = document.getElementById("characterPopover");
      popover.querySelector('[data-character-mode="native"]').click();
      await new Promise((r) => setTimeout(r, 180));
      const notice = document.getElementById("characterPopoverNotice");
      if (!notice || notice.hidden || !notice.textContent.trim()) {
        throw new Error("conflict must surface a reconciliation notice");
      }
      const live = document.getElementById("characterControlLive");
      if (!live.textContent.trim()) throw new Error("conflict must be announced");
      // Reconciled to the server's currentBinding: native at version 3.
      const mod = await import("./modules/character-session-control.js");
      const state = mod.getCharacterControlState();
      if (state.mode !== "native" || state.bindingVersion !== 3) {
        throw new Error("state must reconcile to currentBinding, got " + JSON.stringify({ mode: state.mode, v: state.bindingVersion }));
      }
      const btn = document.getElementById("sessionCharacterBtn");
      if (btn.querySelector(".composer-character-btn-label").textContent.includes("夜游神")) {
        throw new Error("button must drop the stale optimistic name");
      }
      return "reconciled to native@3";
    })()`);
    cwSetBehavior = "ok";
  }

  // 7b. Re-renders must not destroy keyboard focus: the optimistic rebuild in
  // the click handler must land focus back on the equivalent row (asserted
  // synchronously, before the CAS settles and the popover closes).
  await run("focus-restore", `(async () => {
    const popover = document.getElementById("characterPopover");
    if (popover.hidden) throw new Error("popover should still be open after the conflict");
    const longRow = popover.querySelector('[data-character-revision-id="rev-long-1"]');
    longRow.focus();
    popover.querySelector('[data-character-revision-id="rev-night-1"]').click();
    const active = document.activeElement;
    if (active?.dataset?.characterRevisionId !== "rev-long-1") {
      throw new Error("focus should return to the equivalent row after rebuild, got " + (active?.id || active?.className || active?.tagName));
    }
    await new Promise((r) => setTimeout(r, 150));
    return "focus restored";
  })()`);

  // 8. Import preview confirmation flow.
  await run("import-preview", `(async () => {
    const popover = document.getElementById("characterPopover");
    if (popover.hidden) {
      document.getElementById("sessionCharacterBtn").click();
      await new Promise((r) => setTimeout(r, 120));
    }
    document.getElementById("characterImportBtn").click();
    await new Promise((r) => setTimeout(r, 180));
    const preview = document.getElementById("characterImportPreview");
    if (!preview || preview.hidden) throw new Error("preview pane should open");
    if (!preview.textContent.includes("导入的抄写员")) throw new Error("preview shows the card name");
    if (!preview.textContent.includes("v2_json")) throw new Error("preview shows the detected format");
    if (!/8/.test(preview.querySelector("[data-preview-supported]")?.textContent || "")) {
      throw new Error("preview shows the supported field count");
    }
    if (!/2/.test(preview.querySelector("[data-preview-inert]")?.textContent || "")) {
      throw new Error("preview shows the inert field count");
    }
    const warnings = preview.querySelectorAll("[data-preview-warning]");
    if (warnings.length < 1) throw new Error("security warnings must be listed");
    const commit = document.getElementById("characterImportCommitBtn");
    if (!commit || commit.disabled) throw new Error("explicit commit button required");
    if (document.activeElement !== commit) {
      throw new Error("opening the preview must hand focus to the commit command, got " + document.activeElement?.id);
    }
    // No nested cards: one flat panel, no card-in-card chrome.
    if (preview.querySelector(".character-import-preview, .modal-card, [class*='card']")) {
      throw new Error("preview must not nest cards");
    }
    commit.click();
    await new Promise((r) => setTimeout(r, 220));
    if (!preview.hidden) throw new Error("preview closes after commit");
    const mod = await import("./modules/character-session-control.js");
    const state = mod.getCharacterControlState();
    if (state.mode !== "character" || state.characterRevisionId !== "rev-imported-1") {
      throw new Error("commit should import and select, got " + JSON.stringify({ mode: state.mode, rev: state.characterRevisionId }));
    }
    return "imported + selected";
  })()`);

  // 8b. Commit carried the preview token.
  {
    const last = cwCommitCalls.at(-1);
    if (!last || !/^[a-f0-9]{64}$/.test(last.previewToken || "")) {
      console.error("import-commit-token: FAIL " + JSON.stringify(last));
      app.exitCode = 1;
    } else {
      console.log("import-commit-token: ok");
    }
  }

  // 9. NOT_A_CHARACTER_CARD: flow closes, no dead modal, ordinary attachment notice.
  {
    cwPreviewBehavior = "notacard";
    await run("not-a-card", `(async () => {
      const popover = document.getElementById("characterPopover");
      if (popover.hidden) {
        document.getElementById("sessionCharacterBtn").click();
        await new Promise((r) => setTimeout(r, 120));
      }
      document.getElementById("characterImportBtn").click();
      await new Promise((r) => setTimeout(r, 180));
      const preview = document.getElementById("characterImportPreview");
      if (preview && !preview.hidden) throw new Error("no preview may open for an ordinary file");
      const deadModal = document.querySelector(".character-import-preview:not([hidden])");
      if (deadModal) throw new Error("no dead modal may remain");
      const live = document.getElementById("characterControlLive");
      if (!live.textContent.trim()) throw new Error("ordinary-attachment fallback must be announced");
      if (!/添加文件/.test(live.textContent)) {
        throw new Error("notice must point the user at the normal attach-file button: " + live.textContent);
      }
      const mod = await import("./modules/character-session-control.js");
      if (mod.getCharacterControlState().notice !== "ordinary_attachment") {
        throw new Error("notice should be ordinary_attachment");
      }
      return "ordinary attachment fallback";
    })()`);
    cwPreviewBehavior = "card";
  }

  // 10. Fail open: binding load failure leaves native Lily + a quiet notice.
  {
    cwGetBindingBehavior = "CHARACTER_WORLDS_UNAVAILABLE";
    await run("fail-open", `(async () => {
      const store = (await import("./modules/state.js")).default;
      store.set("activeSessionId", "session_other");
      await new Promise((r) => setTimeout(r, 200));
      const mod = await import("./modules/character-session-control.js");
      const state = mod.getCharacterControlState();
      if (state.sessionId !== "session_other") throw new Error("session change not tracked");
      if (state.mode !== "native") throw new Error("IPC failure must leave the session in native mode");
      if (state.notice !== "unavailable") throw new Error("a quiet notice is expected, got " + state.notice);
      const btn = document.getElementById("sessionCharacterBtn");
      if (!btn.querySelector("svg") || btn.querySelector(".composer-character-btn-label").textContent.trim()) {
        throw new Error("native mode shows the unselected icon and no name");
      }
      const swatch = btn.querySelector(".composer-character-btn-swatch");
      if (!swatch.hidden || getComputedStyle(swatch).display !== "none") {
        throw new Error("native mode must not show a ghost swatch");
      }
      store.set("activeSessionId", "session_alpha_recent");
      return "native fallback";
    })()`);
    cwGetBindingBehavior = "ok";
  }

  // 11. Escape closes the popover and returns focus to the trigger.
  await run("escape-close", `(async () => {
    const btn = document.getElementById("sessionCharacterBtn");
    const popover = document.getElementById("characterPopover");
    if (!popover.hidden) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    btn.click();
    await new Promise((r) => setTimeout(r, 120));
    if (popover.hidden) throw new Error("popover should reopen");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (!popover.hidden) throw new Error("Escape should close the popover");
    if (document.activeElement !== btn) throw new Error("Escape should return focus to the trigger");
    if (btn.getAttribute("aria-expanded") !== "false") throw new Error("aria-expanded should reset");
    return "closed";
  })()`);

  // 12. Kill switch: availability loss returns the VIEW to native while the
  // binding is preserved (recovery needs no re-selection).
  {
    await run("kill-switch-view", `(async () => {
      const store = (await import("./modules/state.js")).default;
      const mod = await import("./modules/character-session-control.js");
      const btn = document.getElementById("sessionCharacterBtn");
      const swatch = btn.querySelector(".composer-character-btn-swatch");
      // Recover availability first (fail-open left it off): a successful load
      // proves the feature is back.
      store.set("activeSessionId", "session_other");
      await new Promise((r) => setTimeout(r, 150));
      store.set("activeSessionId", "session_alpha_recent");
      await new Promise((r) => setTimeout(r, 250));
      let state = mod.getCharacterControlState();
      if (state.available !== true) throw new Error("a successful load should restore availability");
      if (state.mode !== "character") throw new Error("alpha should still be bound, got " + state.mode);
      if (swatch.hidden) throw new Error("bound state shows the swatch");
      return "available again";
    })()`);
    cwGetBindingBehavior = "CHARACTER_WORLDS_UNAVAILABLE";
    await run("kill-switch-native-view", `(async () => {
      const store = (await import("./modules/state.js")).default;
      const mod = await import("./modules/character-session-control.js");
      const btn = document.getElementById("sessionCharacterBtn");
      store.set("activeSessionId", "session_other");
      await new Promise((r) => setTimeout(r, 150));
      store.set("activeSessionId", "session_alpha_recent");
      await new Promise((r) => setTimeout(r, 250));
      const state = mod.getCharacterControlState();
      if (state.available !== false) throw new Error("unavailable load must flip availability off");
      if (mod.effectiveCharacterMode(state) !== "native") throw new Error("the view must read native Lily");
      if (state.notice !== "unavailable") throw new Error("a quiet notice is expected");
      const swatch = btn.querySelector(".composer-character-btn-swatch");
      const icon = btn.querySelector(".composer-character-btn-icon");
      if (!swatch.hidden || icon.hidden) throw new Error("native view shows the unselected icon");
      return "native view under kill switch";
    })()`);
    cwGetBindingBehavior = "ok";
    await run("kill-switch-recovery", `(async () => {
      const store = (await import("./modules/state.js")).default;
      const mod = await import("./modules/character-session-control.js");
      const btn = document.getElementById("sessionCharacterBtn");
      store.set("activeSessionId", "session_other");
      await new Promise((r) => setTimeout(r, 150));
      store.set("activeSessionId", "session_alpha_recent");
      await new Promise((r) => setTimeout(r, 250));
      const state = mod.getCharacterControlState();
      if (state.available !== true) throw new Error("availability should recover");
      if (state.mode !== "character" || !state.characterRevisionId) {
        throw new Error("the binding must survive the kill switch, got " + state.mode);
      }
      if (btn.querySelector(".composer-character-btn-swatch").hidden) {
        throw new Error("the swatch returns without any re-selection");
      }
      return "binding preserved";
    })()`);
  }

  // 13. Canonical duplicate: commit must send duplicateResolution=create_copy
  // (the preload whitelists that exact key) and still import + select.
  {
    cwPreviewBehavior = "card-duplicate";
    await run("import-duplicate-copy", `(async () => {
      const btn = document.getElementById("sessionCharacterBtn");
      const popover = document.getElementById("characterPopover");
      if (popover.hidden) {
        btn.click();
        await new Promise((r) => setTimeout(r, 120));
      }
      document.getElementById("characterImportBtn").click();
      await new Promise((r) => setTimeout(r, 200));
      const preview = document.getElementById("characterImportPreview");
      if (preview.hidden) throw new Error("preview should open for the duplicate card");
      const dup = preview.querySelector("[data-preview-duplicate]");
      if (!dup || !/副本/.test(dup.textContent)) throw new Error("duplicate note missing: " + dup?.textContent);
      document.getElementById("characterImportCommitBtn").click();
      await new Promise((r) => setTimeout(r, 250));
      const mod = await import("./modules/character-session-control.js");
      const state = mod.getCharacterControlState();
      if (state.mode !== "character" || state.characterRevisionId !== "rev-imported-1") {
        throw new Error("copy import should select the imported character, got " + JSON.stringify({ mode: state.mode, rev: state.characterRevisionId }));
      }
      return "copy imported + selected";
    })()`);
    cwPreviewBehavior = "card";
    const lastDupCommit = cwCommitCalls.at(-1);
    if (lastDupCommit?.duplicateResolution !== "create_copy") {
      console.error("import-duplicate-resolution: FAIL commit payload " + JSON.stringify(lastDupCommit));
      app.exitCode = 1;
    } else {
      console.log("import-duplicate-resolution: ok");
    }
  }

  // 14. Commit finishing after a session switch completes the import but
  // skips the auto-select into the new conversation.
  {
    cwCommitBehavior = "slow";
    await run("import-switch-skip-select", `(async () => {
      const store = (await import("./modules/state.js")).default;
      const popover = document.getElementById("characterPopover");
      if (popover.hidden) {
        document.getElementById("sessionCharacterBtn").click();
        await new Promise((r) => setTimeout(r, 120));
      }
      document.getElementById("characterImportBtn").click();
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById("characterImportCommitBtn").click();
      store.set("activeSessionId", "session_other");
      await new Promise((r) => setTimeout(r, 600));
      const mod = await import("./modules/character-session-control.js");
      const state = mod.getCharacterControlState();
      if (state.sessionId !== "session_other") throw new Error("session switch not tracked");
      if (state.mode !== "native") throw new Error("the new session must not inherit the import selection");
      if (!state.characters.some((c) => c.id === "char-imported")) {
        throw new Error("the import itself should still complete into the library");
      }
      return "import completed, selection skipped";
    })()`);
    cwCommitBehavior = "ok";
    if (cwBindings.get("session_other")?.mode === "character") {
      console.error("import-switch-no-cross-bind: FAIL session_other was bound");
      app.exitCode = 1;
    } else {
      console.log("import-switch-no-cross-bind: ok");
    }
    await run("import-switch-restore", `(async () => {
      const store = (await import("./modules/state.js")).default;
      store.set("activeSessionId", "session_alpha_recent");
      await new Promise((r) => setTimeout(r, 250));
      return "back on alpha";
    })()`);
  }

  // 15. Stale selection outcome: a slow set-binding resolving after a session
  // switch must not paint session A's character onto session B.
  {
    cwSetBehavior = "slow";
    await run("stale-selection-dropped", `(async () => {
      const store = (await import("./modules/state.js")).default;
      const popover = document.getElementById("characterPopover");
      if (popover.hidden) {
        document.getElementById("sessionCharacterBtn").click();
        await new Promise((r) => setTimeout(r, 120));
      }
      popover.querySelector('[data-character-revision-id="rev-night-1"]').click();
      store.set("activeSessionId", "session_other");
      await new Promise((r) => setTimeout(r, 600));
      const mod = await import("./modules/character-session-control.js");
      const state = mod.getCharacterControlState();
      if (state.sessionId !== "session_other") throw new Error("session switch not tracked");
      if (state.mode !== "native" || state.characterRevisionId !== null) {
        throw new Error("stale settle painted onto the new session: " + JSON.stringify({ mode: state.mode, rev: state.characterRevisionId }));
      }
      if (state.notice) throw new Error("stale outcome must stay silent in the new session");
      return "stale outcome dropped";
    })()`);
    cwSetBehavior = "ok";
    await run("stale-selection-restore", `(async () => {
      const store = (await import("./modules/state.js")).default;
      store.set("activeSessionId", "session_alpha_recent");
      await new Promise((r) => setTimeout(r, 250));
      return "back on alpha";
    })()`);
  }

  // 16. Active session deletion resets the control instead of showing stale state.
  await run("session-null-reset", `(async () => {
    const store = (await import("./modules/state.js")).default;
    store.set("activeSessionId", null);
    await new Promise((r) => setTimeout(r, 120));
    const mod = await import("./modules/character-session-control.js");
    const state = mod.getCharacterControlState();
    if (state.sessionId !== null) throw new Error("null session not tracked");
    if (state.mode !== "native" || state.characterRevisionId !== null) {
      throw new Error("deleting the active session must reset the control");
    }
    const btn = document.getElementById("sessionCharacterBtn");
    if (btn.querySelector(".composer-character-btn-label").textContent.trim()) {
      throw new Error("no name may show without an active session");
    }
    store.set("activeSessionId", "session_alpha_recent");
    await new Promise((r) => setTimeout(r, 250));
    return "reset on null session";
  })()`);

  finish(app.exitCode || 0);
}).catch((error) => {
  console.error("test-character-session-control: harness error", error);
  finish(1);
});
