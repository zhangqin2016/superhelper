#!/usr/bin/env node
"use strict";

/**
 * Electron DOM tests for the character library manager (Character Worlds
 * Phase 2B, Task P2B-4 step 2; design spec §13.2/§13.4).
 *
 * Covers: the popover "manage library" entry replacing the disabled Phase 2
 * placeholder, tabbed character/persona/world-book lists, search + tag
 * filtering, blank creation, field editing with explicit revision creation,
 * revision history + restore-as-new-revision with confirm, duplicate, archive
 * with confirm, export delegation, import report (preserved vs unsupported
 * inert counts), and accessibility (focus trap, Escape, aria-live, labelled
 * dialog). The authoring IPC channels are mocked in main; the library runs
 * against the real index.html DOM and preload bridge.
 */

const electron = require("electron");
const { app, BrowserWindow, ipcMain } = electron;
const path = require("node:path");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error("test-character-library must run under Electron. Use: npx electron scripts/test-character-library.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
let win;

const hardTimeout = setTimeout(() => {
  console.error("test-character-library: timed out");
  try {
    win?.destroy?.();
  } catch {
    // Best effort test cleanup.
  }
  app.exit(1);
  process.exit(1);
}, Number(process.env.TEST_CHARACTER_LIBRARY_TIMEOUT_MS || 120000));

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

// --- Mock character-worlds backend (existing channels) ------------------------
const cwCharacters = [
  {
    schemaVersion: 1,
    id: "char-night",
    ownerScope: "owner",
    displayName: "巡夜人",
    currentRevisionId: "rev-night-2",
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-25T08:00:00.000Z",
    archivedAt: null,
  },
  {
    schemaVersion: 1,
    id: "char-scribe",
    ownerScope: "owner",
    displayName: "书记官",
    currentRevisionId: "rev-scribe-1",
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    archivedAt: null,
  },
];
const characterCanonicals = {
  "rev-night-2": {
    schemaVersion: 1, name: "巡夜人", description: "在古城墙上巡逻的人。",
    personality: "沉稳", scenario: "古城夜晚", firstMessage: "",
    exampleDialogue: "", creatorNotes: "", systemPrompt: "",
    postHistoryInstructions: "", creator: "", characterVersion: "",
    alternateGreetings: [], tags: ["夜晚", "城市"],
  },
  "rev-scribe-1": {
    schemaVersion: 1, name: "书记官", description: "记录一切的人。",
    personality: "", scenario: "", firstMessage: "",
    exampleDialogue: "", creatorNotes: "", systemPrompt: "",
    postHistoryInstructions: "", creator: "", characterVersion: "",
    alternateGreetings: [], tags: ["文书"],
  },
};
const characterHistoryRows = {
  "char-night": [
    { revisionId: "rev-night-2", revisionNumber: 2, sourceKind: "edited", displayName: "巡夜人", createdAt: "2026-07-25T08:00:00.000Z" },
    { revisionId: "rev-night-1", revisionNumber: 1, sourceKind: "created", displayName: "巡夜人", createdAt: "2026-07-24T08:00:00.000Z" },
  ],
  "char-scribe": [
    { revisionId: "rev-scribe-1", revisionNumber: 1, sourceKind: "created", displayName: "书记官", createdAt: "2026-07-24T08:00:00.000Z" },
  ],
};
const cwPersonas = [
  { id: "persona-a", name: "阿黎", currentRevisionId: "rev-persona-1", archivedAt: null, descriptionChars: 12 },
];
const personaCanonicals = {
  "rev-persona-1": { schemaVersion: 1, name: "阿黎", description: "海港制图师。" },
};
const cwBooks = [
  { id: "book-a", name: "港口志", entryCount: 7, currentRevisionId: "rev-book-1", archivedAt: null },
];
const bookHistoryRows = {
  "book-a": [
    { revisionId: "rev-book-1", revisionNumber: 1, sourceKind: "created", displayName: "港口志", createdAt: "2026-07-24T08:00:00.000Z" },
  ],
};

const calls = [];
let createBehavior = "ok";
let editBehavior = "ok";
let nextEntitySeq = 0;
function recordCall(channel, payload) {
  calls.push({ channel, payload });
}

function makeRevision(id, entityId, number, canonical) {
  return {
    id,
    characterId: entityId,
    personaId: entityId,
    worldBookId: entityId,
    revisionNumber: number,
    parentRevisionId: null,
    source: { kind: "created", format: "lily", container: "json" },
    canonical,
    createdAt: "2026-07-25T09:00:00.000Z",
  };
}

ipcMain.handle("character:list", () => ({ ok: true, characters: cwCharacters.filter((c) => !c.archivedAt) }));
ipcMain.handle("character:get", (_e, payload) => ({
  ok: true,
  character: cwCharacters.find((c) => c.id === payload?.characterId) || null,
}));
ipcMain.handle("session-character:get-binding", (_e, payload) => ({
  ok: true,
  binding: {
    schemaVersion: 1, sessionId: payload?.sessionId || "", mode: "native",
    bindingVersion: 0, characterRevisionId: null, compatibilityProfile: null,
  },
}));
ipcMain.handle("session-character:set-binding", (_e, payload) => ({
  ok: true,
  binding: {
    schemaVersion: 1, sessionId: payload?.sessionId || "", mode: "native",
    bindingVersion: (payload?.expectedBindingVersion || 0) + 1,
    characterRevisionId: null, compatibilityProfile: null,
  },
}));
ipcMain.handle("session-character:get-events", () => ({ ok: true, events: [] }));
ipcMain.handle("persona:list", () => ({ ok: true, personas: cwPersonas.filter((p) => !p.archivedAt) }));
ipcMain.handle("persona:get", () => ({ ok: false, error: "PERSONA_NOT_FOUND" }));
ipcMain.handle("world-book:list", () => ({ ok: true, worldBooks: cwBooks.filter((b) => !b.archivedAt) }));
ipcMain.handle("world-book:get", () => ({ ok: false, error: "WORLD_BOOK_NOT_FOUND" }));
ipcMain.handle("world-book:get-revision", () => ({ ok: false, error: "WORLD_BOOK_REVISION_NOT_FOUND" }));

let exportCalls = 0;
ipcMain.handle("character:export", (_e, payload) => {
  exportCalls += 1;
  recordCall("character:export", payload);
  return { ok: true, fileName: "export.json" };
});
ipcMain.handle("character:import-preview", () => ({
  ok: true,
  kind: "characterCard",
  previewToken: "f".repeat(64),
  expiresAt: Date.now() + 60000,
  format: "v2_json",
  container: "json",
  canonical: { schemaVersion: 1, name: "导入的旅人" },
  compatibility: {
    supported: ["/name"], migrated: [], preservedInert: ["/data/extensions/x"],
    ignoredInvalid: [], rejectedExecutable: [],
    counts: { supported: 8, migrated: 0, preservedInert: 3, ignoredInvalid: 0, rejectedExecutable: 0 },
    level: "preserved_inert", truncation: null, warnings: [],
  },
  duplicates: { exact: null, canonical: null },
}));
ipcMain.handle("character:import-commit", (_e, payload) => {
  recordCall("character:import-commit", payload);
  const entity = {
    schemaVersion: 1, id: `char-imported-${nextEntitySeq += 1}`, ownerScope: "owner",
    displayName: "导入的旅人", currentRevisionId: "rev-imported-1",
    createdAt: "2026-07-25T09:00:00.000Z", updatedAt: "2026-07-25T09:00:00.000Z", archivedAt: null,
  };
  cwCharacters.push(entity);
  characterCanonicals["rev-imported-1"] = { schemaVersion: 1, name: "导入的旅人", description: "", tags: [] };
  return { ok: true, entity, revision: { id: "rev-imported-1" }, duplicate: { kind: "none", reused: false } };
});

// --- Mock authoring channels (Phase 2B) ---------------------------------------
ipcMain.handle("character:get-revision", (_e, payload) => {
  recordCall("character:get-revision", payload);
  const canonical = characterCanonicals[payload?.revisionId];
  if (!canonical) return { ok: false, error: "CHARACTER_REVISION_NOT_FOUND" };
  const entity = cwCharacters.find((c) => c.currentRevisionId === payload.revisionId);
  return {
    ok: true,
    revision: makeRevision(payload.revisionId, entity?.id || "char-night",
      payload.revisionId === "rev-night-2" ? 2 : 1, canonical),
  };
});
ipcMain.handle("character:history", (_e, payload) => {
  recordCall("character:history", payload);
  const rows = characterHistoryRows[payload?.characterId];
  if (!rows) return { ok: false, error: "CHARACTER_NOT_FOUND" };
  return { ok: true, revisions: rows };
});
ipcMain.handle("character:create", (_e, payload) => {
  recordCall("character:create", payload);
  if (createBehavior !== "ok") return { ok: false, error: createBehavior };
  const id = `char-new-${nextEntitySeq += 1}`;
  const revisionId = `rev-new-${nextEntitySeq}`;
  const entity = {
    schemaVersion: 1, id, ownerScope: "owner",
    displayName: payload?.canonical?.name || "", currentRevisionId: revisionId,
    createdAt: "2026-07-25T09:00:00.000Z", updatedAt: "2026-07-25T09:00:00.000Z", archivedAt: null,
  };
  cwCharacters.push(entity);
  characterCanonicals[revisionId] = { ...payload.canonical };
  characterHistoryRows[id] = [
    { revisionId, revisionNumber: 1, sourceKind: "created", displayName: entity.displayName, createdAt: "2026-07-25T09:00:00.000Z" },
  ];
  return { ok: true, entity, revision: makeRevision(revisionId, id, 1, payload.canonical) };
});
ipcMain.handle("character:update-revision", (_e, payload) => {
  recordCall("character:update-revision", payload);
  if (editBehavior === "conflict") return { ok: false, error: "CHARACTER_REVISION_CONFLICT" };
  const entity = cwCharacters.find((c) => c.id === payload?.characterId);
  if (!entity) return { ok: false, error: "CHARACTER_NOT_FOUND" };
  if (entity.currentRevisionId !== payload?.expectedBaseRevisionId) {
    return { ok: false, error: "CHARACTER_REVISION_CONFLICT" };
  }
  const revisionId = `${payload.characterId}-rev-${Date.now()}`;
  const rows = characterHistoryRows[payload.characterId] || [];
  const number = (rows[0]?.revisionNumber || 1) + 1;
  entity.currentRevisionId = revisionId;
  entity.displayName = payload?.canonical?.name || entity.displayName;
  characterCanonicals[revisionId] = { ...payload.canonical };
  rows.unshift({ revisionId, revisionNumber: number, sourceKind: "edited", displayName: entity.displayName, createdAt: "2026-07-25T10:00:00.000Z" });
  characterHistoryRows[payload.characterId] = rows;
  return { ok: true, revision: makeRevision(revisionId, payload.characterId, number, payload.canonical) };
});
ipcMain.handle("character:restore-revision", (_e, payload) => {
  recordCall("character:restore-revision", payload);
  const entity = cwCharacters.find((c) => c.id === payload?.characterId);
  if (!entity) return { ok: false, error: "CHARACTER_NOT_FOUND" };
  if (entity.currentRevisionId !== payload?.expectedBaseRevisionId) {
    return { ok: false, error: "CHARACTER_REVISION_CONFLICT" };
  }
  const source = characterCanonicals[payload?.revisionId]
    || (payload?.revisionId === "rev-night-1" ? {
      schemaVersion: 1, name: "巡夜人", description: "最初的描述。", tags: ["夜晚"],
    } : null);
  if (!source) return { ok: false, error: "CHARACTER_REVISION_NOT_FOUND" };
  const revisionId = `${payload.characterId}-restored-${Date.now()}`;
  const rows = characterHistoryRows[payload.characterId] || [];
  const number = (rows[0]?.revisionNumber || 1) + 1;
  entity.currentRevisionId = revisionId;
  characterCanonicals[revisionId] = { ...source };
  rows.unshift({ revisionId, revisionNumber: number, sourceKind: "created", displayName: entity.displayName, createdAt: "2026-07-25T11:00:00.000Z" });
  return { ok: true, revision: makeRevision(revisionId, payload.characterId, number, { ...source }) };
});
ipcMain.handle("character:duplicate", (_e, payload) => {
  recordCall("character:duplicate", payload);
  const entity = cwCharacters.find((c) => c.id === payload?.characterId);
  if (!entity) return { ok: false, error: "CHARACTER_NOT_FOUND" };
  const id = `char-copy-${nextEntitySeq += 1}`;
  const revisionId = `rev-copy-${nextEntitySeq}`;
  const copy = { ...entity, id, currentRevisionId: revisionId, archivedAt: null };
  cwCharacters.push(copy);
  characterCanonicals[revisionId] = { ...characterCanonicals[entity.currentRevisionId] };
  characterHistoryRows[id] = [
    { revisionId, revisionNumber: 1, sourceKind: "created", displayName: copy.displayName, createdAt: "2026-07-25T12:00:00.000Z" },
  ];
  return { ok: true, entity: copy, revision: makeRevision(revisionId, id, 1, characterCanonicals[revisionId]) };
});
ipcMain.handle("character:archive", (_e, payload) => {
  recordCall("character:archive", payload);
  const entity = cwCharacters.find((c) => c.id === payload?.characterId);
  if (!entity) return { ok: false, error: "CHARACTER_NOT_FOUND" };
  entity.archivedAt = "2026-07-25T12:00:00.000Z";
  return { ok: true, entity };
});
ipcMain.handle("persona:create", (_e, payload) => {
  recordCall("persona:create", payload);
  const id = `persona-new-${nextEntitySeq += 1}`;
  const revisionId = `rev-persona-new-${nextEntitySeq}`;
  cwPersonas.push({
    id, name: payload?.canonical?.name || "", currentRevisionId: revisionId,
    archivedAt: null, descriptionChars: (payload?.canonical?.description || "").length,
  });
  personaCanonicals[revisionId] = { ...payload.canonical };
  return { ok: true, entity: { id }, revision: makeRevision(revisionId, id, 1, payload.canonical) };
});
ipcMain.handle("persona:update-revision", (_e, payload) => {
  recordCall("persona:update-revision", payload);
  const entity = cwPersonas.find((p) => p.id === payload?.personaId);
  if (!entity) return { ok: false, error: "PERSONA_NOT_FOUND" };
  const revisionId = `${payload.personaId}-rev-${Date.now()}`;
  entity.currentRevisionId = revisionId;
  personaCanonicals[revisionId] = { ...payload.canonical };
  return { ok: true, revision: makeRevision(revisionId, payload.personaId, 2, payload.canonical) };
});
ipcMain.handle("persona:archive", (_e, payload) => {
  recordCall("persona:archive", payload);
  const entity = cwPersonas.find((p) => p.id === payload?.personaId);
  if (!entity) return { ok: false, error: "PERSONA_NOT_FOUND" };
  entity.archivedAt = "2026-07-25T12:00:00.000Z";
  return { ok: true, entity };
});
ipcMain.handle("persona:get-revision", (_e, payload) => {
  recordCall("persona:get-revision", payload);
  const canonical = personaCanonicals[payload?.revisionId];
  if (!canonical) return { ok: false, error: "PERSONA_REVISION_NOT_FOUND" };
  return { ok: true, revision: makeRevision(payload.revisionId, "persona-a", 1, canonical) };
});
ipcMain.handle("persona:history", () => ({ ok: true, revisions: [
  { revisionId: "rev-persona-1", revisionNumber: 1, sourceKind: "created", displayName: "阿黎", createdAt: "2026-07-24T08:00:00.000Z" },
] }));
ipcMain.handle("world-book:create", (_e, payload) => {
  recordCall("world-book:create", payload);
  const id = `book-new-${nextEntitySeq += 1}`;
  cwBooks.push({ id, name: payload?.canonical?.name || "", entryCount: 0, currentRevisionId: `rev-${id}`, archivedAt: null });
  bookHistoryRows[id] = [
    { revisionId: `rev-${id}`, revisionNumber: 1, sourceKind: "created", displayName: payload?.canonical?.name || "", createdAt: "2026-07-25T09:00:00.000Z" },
  ];
  return { ok: true, entity: { id }, revision: makeRevision(`rev-${id}`, id, 1, payload.canonical) };
});
ipcMain.handle("world-book:archive", (_e, payload) => {
  recordCall("world-book:archive", payload);
  const entity = cwBooks.find((b) => b.id === payload?.worldBookId);
  if (!entity) return { ok: false, error: "WORLD_BOOK_NOT_FOUND" };
  entity.archivedAt = "2026-07-25T12:00:00.000Z";
  return { ok: true, entity };
});
ipcMain.handle("world-book:history", (_e, payload) => {
  const rows = bookHistoryRows[payload?.worldBookId];
  if (!rows) return { ok: false, error: "WORLD_BOOK_NOT_FOUND" };
  return { ok: true, revisions: rows };
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
ipcMain.handle("session:switch", (_e, sessionId) => ({ ok: true, conversation: [], session: { id: sessionId, title: "Alpha chat" } }));
ipcMain.handle("state:full", () => ({
  projects: rendererProjects,
  activeProjectId: "project_alpha",
  activeSessionId: "session_alpha_recent",
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
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await new Promise((r) => setTimeout(r, 1800));

  // 1. The library module loads and exposes its API.
  await run("module-import", `(async () => {
    const mod = await import("./modules/character-library.js");
    for (const name of ["initCharacterLibrary", "openCharacterLibrary", "getCharacterLibraryState"]) {
      if (typeof mod[name] !== "function") throw new Error("missing export " + name);
    }
    const model = await import("./modules/character-library-model.js");
    for (const name of ["initialCharacterLibraryState", "reduceCharacterLibrary", "filterLibraryItems"]) {
      if (typeof model[name] !== "function") throw new Error("missing model export " + name);
    }
    return "exports present";
  })()`);

  // 2. The popover manage entry is enabled (Phase 2 placeholder replaced) and
  // opens the library, closing the popover and moving focus into the dialog.
  await run("open-from-popover", `(async () => {
    const manageBtn = document.getElementById("characterManageBtn");
    if (!manageBtn) throw new Error("manage button missing");
    if (manageBtn.disabled) throw new Error("manage library must be enabled in Phase 2B");
    if (/Phase 2|第二/.test(manageBtn.textContent)) throw new Error("Phase 2 placeholder label must be gone: " + manageBtn.textContent);
    document.getElementById("sessionCharacterBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const popover = document.getElementById("characterPopover");
    if (popover.hidden) throw new Error("popover should open first");
    manageBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    if (!popover.hidden) throw new Error("opening the library closes the popover");
    const modal = document.getElementById("characterLibraryModal");
    if (!modal || modal.hidden) throw new Error("library modal should open");
    const dialog = modal.querySelector("[role='dialog']");
    if (!dialog || dialog.getAttribute("aria-modal") !== "true") throw new Error("library needs an aria-modal dialog");
    if (!dialog.getAttribute("aria-labelledby")) throw new Error("dialog must be labelled");
    if (!modal.contains(document.activeElement)) throw new Error("focus must move into the library");
    return "library open";
  })()`);

  // 3. Characters tab lists rows with edit/history/duplicate/export/archive actions.
  await run("character-rows", `(async () => {
    const list = document.getElementById("characterLibraryList");
    const rows = [...list.querySelectorAll("[data-entity-id]")];
    if (rows.length !== 2) throw new Error("expected 2 character rows, got " + rows.length);
    if (!rows.some((r) => r.textContent.includes("巡夜人"))) throw new Error("巡夜人 row missing");
    const actions = [...rows[0].querySelectorAll("[data-library-action]")].map((b) => b.dataset.libraryAction);
    for (const action of ["edit", "history", "duplicate", "export", "archive"]) {
      if (!actions.includes(action)) throw new Error("character row missing action " + action);
    }
    const night = rows.find((r) => r.textContent.includes("巡夜人"));
    if (!night.textContent.includes("夜晚")) throw new Error("tag chips should render in the row meta");
    return "rows=" + rows.length;
  })()`);

  // 4. Search filters by name; tag filter narrows by tag.
  await run("search-and-tag-filter", `(async () => {
    const search = document.getElementById("characterLibrarySearch");
    const list = document.getElementById("characterLibraryList");
    const visibleRows = () => [...list.querySelectorAll("[data-entity-id]")];
    search.value = "书记";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (visibleRows().length !== 1) throw new Error("search should narrow to 1 row, got " + visibleRows().length);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (visibleRows().length !== 2) throw new Error("clearing search restores rows");
    const tag = document.getElementById("characterLibraryTagFilter");
    tag.value = "夜晚";
    tag.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (visibleRows().length !== 1 || !visibleRows()[0].textContent.includes("巡夜人")) {
      throw new Error("tag filter should keep only 巡夜人");
    }
    tag.value = "";
    tag.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return "filters work";
  })()`);

  // 5. Tabs switch to personas and world books with read-first metadata.
  await run("tabs", `(async () => {
    const tablist = document.getElementById("characterLibraryTabs");
    if (tablist.getAttribute("role") !== "tablist") throw new Error("tabs need role=tablist");
    const tabs = [...tablist.querySelectorAll("[role='tab']")];
    if (tabs.length !== 3) throw new Error("expected 3 tabs");
    tabs.find((t) => t.dataset.libraryTab === "personas").click();
    await new Promise((r) => setTimeout(r, 200));
    let rows = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")];
    if (rows.length !== 1 || !rows[0].textContent.includes("阿黎")) throw new Error("persona row missing");
    let actions = [...rows[0].querySelectorAll("[data-library-action]")].map((b) => b.dataset.libraryAction);
    if (!actions.includes("edit") || !actions.includes("archive") || actions.includes("export")) {
      throw new Error("persona actions should be edit/history/archive, got " + actions.join(","));
    }
    tabs.find((t) => t.dataset.libraryTab === "books").click();
    await new Promise((r) => setTimeout(r, 200));
    rows = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")];
    if (rows.length !== 1 || !rows[0].textContent.includes("港口志")) throw new Error("world book row missing");
    if (!/7/.test(rows[0].textContent)) throw new Error("book row shows the entry count");
    actions = [...rows[0].querySelectorAll("[data-library-action]")].map((b) => b.dataset.libraryAction);
    if (actions.includes("edit") || !actions.includes("archive") || !actions.includes("history")) {
      throw new Error("book actions should be history/archive only, got " + actions.join(","));
    }
    const tagFilter = document.getElementById("characterLibraryTagFilter");
    if (!tagFilter.closest("[hidden]") && !tagFilter.hidden) throw new Error("tag filter hides off the characters tab");
    tabs.find((t) => t.dataset.libraryTab === "characters").click();
    await new Promise((r) => setTimeout(r, 200));
    return "tabs switch";
  })()`);

  // 6. Create a blank character: minimal form, save creates revision 1.
  await run("create-blank", `(async () => {
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const detail = document.getElementById("characterLibraryDetail");
    if (detail.hidden) throw new Error("create form should open");
    const nameInput = detail.querySelector("[data-field='name']");
    const descInput = detail.querySelector("[data-field='description']");
    if (!nameInput || !descInput) throw new Error("minimal form needs name + description");
    if (detail.querySelector("[data-field='tags']") == null) throw new Error("character form offers tags");
    nameInput.value = "新角色";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    descInput.value = "刚创建的角色。";
    descInput.dispatchEvent(new Event("input", { bubbles: true }));
    detail.querySelector("[data-library-save]").click();
    await new Promise((r) => setTimeout(r, 300));
    const live = document.getElementById("characterLibraryLive");
    if (!live.textContent.includes("新角色")) throw new Error("creation must be announced: " + live.textContent);
    const rows = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")];
    if (!rows.some((r) => r.textContent.includes("新角色"))) throw new Error("the new character should be listed");
    return "created";
  })()`);
  {
    const create = calls.filter((c) => c.channel === "character:create").at(-1);
    if (!create || create.payload?.canonical?.name !== "新角色"
      || create.payload?.canonical?.description !== "刚创建的角色。"
      || "ownerScope" in (create.payload || {})) {
      console.error("create-payload: FAIL " + JSON.stringify(create));
      app.exitCode = 1;
    } else {
      console.log("create-payload: ok");
    }
  }

  // 7. Edit creates revision N+1 explicitly; the new revision number shows.
  await run("edit-revision", `(async () => {
    const list = document.getElementById("characterLibraryList");
    const row = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("巡夜人"));
    row.querySelector("[data-library-action='edit']").click();
    await new Promise((r) => setTimeout(r, 250));
    const detail = document.getElementById("characterLibraryDetail");
    if (detail.hidden) throw new Error("edit form should open");
    const revisionLine = detail.querySelector("[data-library-revision]");
    if (!revisionLine || !/2/.test(revisionLine.textContent)) {
      throw new Error("edit form shows the base revision number: " + revisionLine?.textContent);
    }
    const desc = detail.querySelector("[data-field='description']");
    if (desc.value !== "在古城墙上巡逻的人。") throw new Error("form is pre-filled from the stored canonical");
    const tags = detail.querySelector("[data-field='tags']");
    if (!tags.value.includes("夜晚")) throw new Error("tags pre-filled");
    desc.value = "改写的描述。";
    desc.dispatchEvent(new Event("input", { bubbles: true }));
    detail.querySelector("[data-library-save]").click();
    await new Promise((r) => setTimeout(r, 300));
    const live = document.getElementById("characterLibraryLive");
    if (!/3/.test(live.textContent)) throw new Error("save announces the new revision number: " + live.textContent);
    return "edited to revision 3";
  })()`);
  {
    const edit = calls.filter((c) => c.channel === "character:update-revision").at(-1);
    if (!edit || edit.payload?.characterId !== "char-night"
      || edit.payload?.expectedBaseRevisionId !== "rev-night-2"
      || edit.payload?.canonical?.description !== "改写的描述。"
      || edit.payload?.canonical?.personality !== "沉稳") {
      console.error("edit-payload: FAIL " + JSON.stringify(edit));
      app.exitCode = 1;
    } else {
      console.log("edit-payload: ok");
    }
  }

  // 8. Revision history + restore-as-new-revision behind an explicit confirm.
  await run("history-restore", `(async () => {
    const list = document.getElementById("characterLibraryList");
    const row = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("巡夜人"));
    row.querySelector("[data-library-action='history']").click();
    await new Promise((r) => setTimeout(r, 250));
    const detail = document.getElementById("characterLibraryDetail");
    if (detail.hidden) throw new Error("history view should open");
    const rows = [...detail.querySelectorAll("[data-history-revision-id]")];
    if (rows.length < 2) throw new Error("history lists revisions, got " + rows.length);
    if (!/2/.test(rows[0].textContent)) throw new Error("history rows show revision numbers");
    const restoreBtn = detail.querySelector("[data-history-revision-id='rev-night-1'] [data-library-restore]");
    if (!restoreBtn) throw new Error("character history rows offer restore");
    restoreBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    const confirmBar = detail.querySelector("[data-library-confirm='yes']");
    if (!confirmBar) throw new Error("restore needs an explicit confirm");
    confirmBar.click();
    await new Promise((r) => setTimeout(r, 300));
    const live = document.getElementById("characterLibraryLive");
    if (!live.textContent.trim()) throw new Error("restore must be announced");
    return "restored";
  })()`);
  {
    const restore = calls.filter((c) => c.channel === "character:restore-revision").at(-1);
    if (!restore || restore.payload?.characterId !== "char-night"
      || restore.payload?.revisionId !== "rev-night-1") {
      console.error("restore-payload: FAIL " + JSON.stringify(restore));
      app.exitCode = 1;
    } else {
      console.log("restore-payload: ok");
    }
  }

  // 9. Duplicate creates a copy; archive requires confirm and removes the row.
  await run("duplicate-and-archive", `(async () => {
    const list = document.getElementById("characterLibraryList");
    const scribe = () => [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("书记官"));
    scribe().querySelector("[data-library-action='duplicate']").click();
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...list.querySelectorAll("[data-entity-id]")].filter((r) => r.textContent.includes("书记官"));
    if (rows.length !== 2) throw new Error("duplicate should add a copy row, got " + rows.length);
    const live = document.getElementById("characterLibraryLive");
    if (!live.textContent.trim()) throw new Error("duplicate announced");
    rows[1].querySelector("[data-library-action='archive']").click();
    await new Promise((r) => setTimeout(r, 100));
    const confirmBar = list.querySelector("[data-library-confirm='yes']");
    if (!confirmBar) throw new Error("archive needs an explicit confirm");
    confirmBar.click();
    await new Promise((r) => setTimeout(r, 300));
    const remaining = [...list.querySelectorAll("[data-entity-id]")].filter((r) => r.textContent.includes("书记官"));
    if (remaining.length !== 1) throw new Error("archive removes the row, got " + remaining.length);
    return "duplicated + archived";
  })()`);
  {
    const dup = calls.filter((c) => c.channel === "character:duplicate").at(-1);
    const arch = calls.filter((c) => c.channel === "character:archive").at(-1);
    if (!dup || dup.payload?.characterId !== "char-scribe" || !arch) {
      console.error("duplicate/archive-payload: FAIL " + JSON.stringify({ dup, arch }));
      app.exitCode = 1;
    } else {
      console.log("duplicate/archive-payload: ok");
    }
  }

  // 10. Export delegates to the existing save-dialog flow with the current revision.
  await run("export", `(async () => {
    const list = document.getElementById("characterLibraryList");
    const row = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("巡夜人"));
    row.querySelector("[data-library-action='export']").click();
    await new Promise((r) => setTimeout(r, 250));
    const live = document.getElementById("characterLibraryLive");
    if (!live.textContent.trim()) throw new Error("export result announced");
    return "exported";
  })()`);
  {
    const exp = calls.filter((c) => c.channel === "character:export").at(-1);
    if (!exp || typeof exp.payload?.revisionId !== "string" || !exp.payload.revisionId) {
      console.error("export-payload: FAIL " + JSON.stringify(exp));
      app.exitCode = 1;
    } else {
      console.log("export-payload: ok");
    }
  }

  // 11. Import from the library commits and shows the report counts.
  await run("import-report", `(async () => {
    document.getElementById("characterLibraryImportBtn").click();
    await new Promise((r) => setTimeout(r, 400));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("导入的旅人")) {
      throw new Error("import report shows the imported name: " + notice.textContent);
    }
    if (!/8/.test(notice.textContent) || !/3/.test(notice.textContent)) {
      throw new Error("import report shows preserved vs inert counts: " + notice.textContent);
    }
    const live = document.getElementById("characterLibraryLive");
    if (!live.textContent.includes("导入的旅人")) throw new Error("import report announced");
    const rows = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")];
    if (!rows.some((r) => r.textContent.includes("导入的旅人"))) throw new Error("imported character listed");
    return "report shown";
  })()`);

  // 12. Mutation failure surfaces a quiet notice and keeps the list intact.
  {
    createBehavior = "CHARACTER_WORLDS_UNAVAILABLE";
    await run("mutation-fail-open", `(async () => {
      const before = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")].length;
      document.getElementById("characterLibraryCreateBtn").click();
      await new Promise((r) => setTimeout(r, 120));
      const detail = document.getElementById("characterLibraryDetail");
      const nameInput = detail.querySelector("[data-field='name']");
      nameInput.value = "失败角色";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      detail.querySelector("[data-library-save]").click();
      await new Promise((r) => setTimeout(r, 300));
      const notice = document.getElementById("characterLibraryNotice");
      if (notice.hidden || !notice.textContent.trim()) throw new Error("failure surfaces a quiet notice");
      const after = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")].length;
      if (after !== before) throw new Error("failed create must not add a row");
      return "fail open";
    })()`);
    createBehavior = "ok";
  }

  // 13. Accessibility: focus trap wraps inside the modal, Escape closes and
  // returns focus to the character control button.
  await run("focus-trap-escape", `(async () => {
    const modal = document.getElementById("characterLibraryModal");
    if (modal.hidden) throw new Error("modal should still be open");
    // Step 12 left a dirty form open; cancel it explicitly (the close guard
    // keeps Escape from discarding it, which is tested separately below).
    const detail = document.getElementById("characterLibraryDetail");
    if (!detail.hidden) {
      detail.querySelector("[data-library-back]")?.click();
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!detail.hidden) throw new Error("cancel returns to the list view");
    const focusables = () => [...modal.querySelectorAll("button:not([disabled]), input, textarea")]
      .filter((el) => !el.closest("[hidden]") && el.offsetParent !== null || !el.closest("[hidden]"));
    const items = focusables();
    if (items.length < 5) throw new Error("need several focusable controls, got " + items.length);
    const press = (key, options = {}) => modal.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
    items[0].focus();
    press("Tab", { shiftKey: true });
    if (document.activeElement !== items[items.length - 1]) {
      throw new Error("Shift+Tab on the first control wraps to the last, got " + (document.activeElement?.id || document.activeElement?.tagName));
    }
    press("Tab");
    if (document.activeElement !== items[0]) throw new Error("Tab on the last control wraps to the first");
    press("Escape");
    await new Promise((r) => setTimeout(r, 100));
    if (!modal.hidden) throw new Error("Escape closes the library");
    const btn = document.getElementById("sessionCharacterBtn");
    if (document.activeElement !== btn) throw new Error("focus returns to the character control button");
    return "trap + escape verified";
  })()`);

  // 14. Form data-loss guards (review fix 1): re-renders never wipe edits.
  await run("empty-name-keeps-fields", `(async () => {
    const mod = await import("./modules/character-library.js");
    await mod.openCharacterLibrary();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const detail = document.getElementById("characterLibraryDetail");
    const desc = detail.querySelector("[data-field='description']");
    desc.value = "只有描述，没有名称。";
    desc.dispatchEvent(new Event("input", { bubbles: true }));
    detail.querySelector("[data-library-save]").click();
    await new Promise((r) => setTimeout(r, 250));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("名称")) {
      throw new Error("empty name must surface the name-required notice: " + notice.textContent);
    }
    const descAfter = document.querySelector("#characterLibraryDetail [data-field='description']");
    if (descAfter.value !== "只有描述，没有名称。") {
      throw new Error("name_required re-render wiped the typed description");
    }
    return "fields kept";
  })()`);

  {
    createBehavior = "CHARACTER_WORLDS_UNAVAILABLE";
    await run("failed-save-keeps-edits", `(async () => {
      const detail = document.getElementById("characterLibraryDetail");
      const name = detail.querySelector("[data-field='name']");
      name.value = "保留我";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      detail.querySelector("[data-library-save]").click();
      await new Promise((r) => setTimeout(r, 300));
      const notice = document.getElementById("characterLibraryNotice");
      if (notice.hidden || !notice.textContent.trim()) throw new Error("failure notice missing");
      const nameAfter = document.querySelector("#characterLibraryDetail [data-field='name']");
      const descAfter = document.querySelector("#characterLibraryDetail [data-field='description']");
      if (nameAfter.value !== "保留我" || descAfter.value !== "只有描述，没有名称。") {
        throw new Error("failed save wiped the in-progress edits: " + JSON.stringify([nameAfter.value, descAfter.value]));
      }
      detail.querySelector("[data-library-back]").click();
      await new Promise((r) => setTimeout(r, 100));
      return "edits kept";
    })()`);
    createBehavior = "ok";
  }

  await run("locale-change-keeps-edits", `(async () => {
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const detail = document.getElementById("characterLibraryDetail");
    const name = detail.querySelector("[data-field='name']");
    name.value = "跨语言保留";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const mod = await import("./modules/character-library.js");
    mod.refreshCharacterLibraryUi();
    await new Promise((r) => setTimeout(r, 100));
    const nameAfter = document.querySelector("#characterLibraryDetail [data-field='name']");
    if (nameAfter.value !== "跨语言保留") {
      throw new Error("locale refresh wiped the typed name");
    }
    detail.querySelector("[data-library-back]").click();
    await new Promise((r) => setTimeout(r, 100));
    return "edits kept across refresh";
  })()`);

  // 15. Conflict notice is distinct from the generic failure (review fix 2).
  {
    editBehavior = "conflict";
    await run("conflict-notice", `(async () => {
      const list = document.getElementById("characterLibraryList");
      const row = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("巡夜人"));
      row.querySelector("[data-library-action='edit']").click();
      await new Promise((r) => setTimeout(r, 250));
      const detail = document.getElementById("characterLibraryDetail");
      const desc = detail.querySelector("[data-field='description']");
      desc.value = "冲突编辑";
      desc.dispatchEvent(new Event("input", { bubbles: true }));
      detail.querySelector("[data-library-save]").click();
      await new Promise((r) => setTimeout(r, 300));
      const notice = document.getElementById("characterLibraryNotice");
      if (notice.hidden || !notice.textContent.includes("另一处")) {
        throw new Error("conflict must get its own notice, got: " + notice.textContent);
      }
      if (notice.textContent.includes("操作失败，请重试")) {
        throw new Error("conflict must not collapse into the generic failure notice");
      }
      const descAfter = document.querySelector("#characterLibraryDetail [data-field='description']");
      if (descAfter.value !== "冲突编辑") throw new Error("conflict failure wiped the edit");
      detail.querySelector("[data-library-back]").click();
      await new Promise((r) => setTimeout(r, 100));
      return "conflict notice distinct";
    })()`);
    editBehavior = "ok";
  }

  // 16. Restore uses the CURRENT revision as its CAS base, even when another
  // edit lands after the history view opened (review fix 3).
  let externalRevisionId = await run("restore-fresh-cas-base", `(async () => {
    // An "external" edit lands through the same bridge before restore.
    const fresh = await window.assistantClient.characterWorlds.getCharacter("char-night");
    const base = fresh.character.currentRevisionId;
    const edited = await window.assistantClient.characterWorlds.updateCharacterRevision({
      characterId: "char-night",
      expectedBaseRevisionId: base,
      canonical: { schemaVersion: 1, name: "巡夜人", description: "外部修改", tags: [] },
    });
    if (!edited?.ok) throw new Error("external edit failed: " + JSON.stringify(edited));
    const after = await window.assistantClient.characterWorlds.getCharacter("char-night");
    const list = document.getElementById("characterLibraryList");
    const row = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("巡夜人"));
    row.querySelector("[data-library-action='history']").click();
    await new Promise((r) => setTimeout(r, 250));
    const detail = document.getElementById("characterLibraryDetail");
    const restoreBtn = detail.querySelector("[data-history-revision-id='rev-night-1'] [data-library-restore]");
    restoreBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    detail.querySelector("[data-library-confirm='yes']").click();
    await new Promise((r) => setTimeout(r, 300));
    const live = document.getElementById("characterLibraryLive");
    if (!live.textContent.trim()) throw new Error("restore must be announced");
    return after.character.currentRevisionId;
  })()`);
  {
    const restore = calls.filter((c) => c.channel === "character:restore-revision").at(-1);
    if (!restore) {
      console.error("restore-cas-base: FAIL missing restore call");
      app.exitCode = 1;
    } else if (externalRevisionId
      && restore.payload?.expectedBaseRevisionId !== externalRevisionId) {
      // The base must be the revision the external edit produced (the mock
      // also rejects any stale base, so success alone proves freshness).
      console.error("restore-cas-base: FAIL base "
        + `${restore.payload?.expectedBaseRevisionId} !== fresh ${externalRevisionId}`);
      app.exitCode = 1;
    } else {
      console.log("restore-cas-base: ok");
    }
  }

  // 17. Confirm bars take focus; dismissing restores it (review fix 4).
  await run("confirm-focus", `(async () => {
    const mod = await import("./modules/character-library.js");
    if (document.getElementById("characterLibraryModal").hidden) {
      await mod.openCharacterLibrary();
      await new Promise((r) => setTimeout(r, 250));
    }
    const list = document.getElementById("characterLibraryList");
    const row = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("书记官"));
    const archiveBtn = row.querySelector("[data-library-action='archive']");
    archiveBtn.click();
    await new Promise((r) => setTimeout(r, 120));
    const yes = list.querySelector("[data-library-confirm='yes']");
    if (!yes) throw new Error("confirm bar missing");
    if (document.activeElement !== yes) {
      throw new Error("focus must move into the confirm bar, got " + (document.activeElement?.textContent || document.activeElement?.tagName));
    }
    const rowAgain = [...list.querySelectorAll("[data-entity-id]")].find((r) => r.textContent.includes("书记官"));
    rowAgain.querySelector("[data-library-confirm='no']").click();
    await new Promise((r) => setTimeout(r, 120));
    const archiveAgain = [...list.querySelectorAll("[data-entity-id]")]
      .find((r) => r.textContent.includes("书记官"))
      ?.querySelector("[data-library-action='archive']");
    if (document.activeElement !== archiveAgain) {
      throw new Error("dismiss must return focus to the archive action");
    }
    return "confirm focus round-trip";
  })()`);

  // 18. Dirty form cannot be closed silently (review fix 5).
  await run("unsaved-close-guard", `(async () => {
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const detail = document.getElementById("characterLibraryDetail");
    const name = detail.querySelector("[data-field='name']");
    name.value = "未保存的角色";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const modal = document.getElementById("characterLibraryModal");
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    if (modal.hidden) throw new Error("Escape must not discard a dirty form");
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("未保存")) {
      throw new Error("unsaved-changes notice missing: " + notice.textContent);
    }
    const nameAfter = document.querySelector("#characterLibraryDetail [data-field='name']");
    if (nameAfter.value !== "未保存的角色") throw new Error("the guard wiped the edit");
    // Backdrop click is guarded the same way.
    modal.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    if (modal.hidden) throw new Error("backdrop click must not discard a dirty form");
    // Cancel is the explicit discard; then Escape closes cleanly.
    detail.querySelector("[data-library-back]").click();
    await new Promise((r) => setTimeout(r, 100));
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    if (!modal.hidden) throw new Error("Escape closes once the form is discarded");
    return "guard holds";
  })()`);

  // 19. The dirty-form guard also covers tab switches and the New button.
  await run("dirty-form-tab-guard", `(async () => {
    const mod = await import("./modules/character-library.js");
    await mod.openCharacterLibrary();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const detail = document.getElementById("characterLibraryDetail");
    const name = detail.querySelector("[data-field='name']");
    name.value = "切换前输入";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    // Dirty: a tab click is refused with the unsaved notice.
    document.querySelector("[data-library-tab='personas']").click();
    await new Promise((r) => setTimeout(r, 150));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("未保存")) {
      throw new Error("dirty tab switch must surface the unsaved notice: " + notice.textContent);
    }
    if (detail.hidden) throw new Error("dirty tab switch must keep the form");
    if (detail.querySelector("[data-field='name']").value !== "切换前输入") {
      throw new Error("the guarded switch wiped the edit");
    }
    if (document.querySelector("[data-library-tab='characters']").getAttribute("aria-selected") !== "true") {
      throw new Error("tab must not switch while the form is dirty");
    }
    // The New button is guarded the same way.
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    if (detail.hidden || detail.querySelector("[data-field='name']").value !== "切换前输入") {
      throw new Error("the New button must not replace a dirty form");
    }
    // Cancel, then a CLEAN form blocks nothing.
    detail.querySelector("[data-library-back]").click();
    await new Promise((r) => setTimeout(r, 100));
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    document.querySelector("[data-library-tab='personas']").click();
    await new Promise((r) => setTimeout(r, 250));
    if (document.querySelector("[data-library-tab='personas']").getAttribute("aria-selected") !== "true") {
      throw new Error("a clean form must not block a tab switch");
    }
    const rows = [...document.querySelectorAll("#characterLibraryList [data-entity-id]")];
    if (!rows.some((r) => r.textContent.includes("阿黎"))) throw new Error("persona tab should list after switch");
    const modal = document.getElementById("characterLibraryModal");
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    return "guard holds on tab switch + New";
  })()`);

  finish(app.exitCode || 0);
}).catch((error) => {
  console.error("test-character-library: harness error", error);
  finish(1);
});
