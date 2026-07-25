#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error(
    "test-workspace-navigation must run under Electron. "
      + "Use: npx electron scripts/test-workspace-navigation.cjs",
  );
  process.exit(2);
}

const root = path.join(__dirname, "..");
const seedProjects = [
  {
    id: "a",
    name: "Workspace Alpha",
    path: "/tmp/workspace-alpha",
    sessions: [
      {
        id: "a-1",
        title: "Alpha historical exact",
        createdAt: "2026-07-20T08:00:00.000Z",
        updatedAt: "2026-07-21T08:00:00.000Z",
        messageCount: 1,
      },
      {
        id: "a-2",
        title: "Alpha roadmap",
        createdAt: "2026-07-22T08:00:00.000Z",
        updatedAt: "2026-07-23T08:00:00.000Z",
        messageCount: 2,
      },
      {
        id: "a-3",
        title: "Alpha latest handoff",
        createdAt: "2026-07-24T08:00:00.000Z",
        updatedAt: "2026-07-25T08:00:00.000Z",
        messageCount: 3,
      },
    ],
  },
  {
    id: "b",
    name: "Workspace Beta",
    path: "/tmp/workspace-beta",
    sessions: [
      {
        id: "b-1",
        title: "Beta historical notes",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-20T08:00:00.000Z",
        messageCount: 4,
      },
      {
        id: "b-2",
        title: "Beta launch checklist",
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-22T08:00:00.000Z",
        messageCount: 5,
      },
      {
        id: "b-3",
        title: "Beta delivery review",
        createdAt: "2026-07-23T08:00:00.000Z",
        updatedAt: "2026-07-26T08:00:00.000Z",
        messageCount: 6,
      },
    ],
  },
  {
    id: "c",
    name: "Workspace Gamma",
    path: "/tmp/workspace-gamma",
    sessions: [
      {
        id: "c-1",
        title: "Gamma early research",
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-19T08:00:00.000Z",
        messageCount: 7,
      },
      {
        id: "c-2",
        title: "Gamma experiment",
        createdAt: "2026-07-20T08:00:00.000Z",
        updatedAt: "2026-07-24T08:00:00.000Z",
        messageCount: 8,
      },
      {
        id: "c-3",
        title: "Gamma current status",
        createdAt: "2026-07-24T08:00:00.000Z",
        updatedAt: "2026-07-27T08:00:00.000Z",
        messageCount: 9,
      },
    ],
  },
  {
    id: "d",
    name: "Workspace Delta Empty",
    path: "/tmp/workspace-delta-empty",
    sessions: [],
  },
];

const clone = (value) => JSON.parse(JSON.stringify(value));
const captureDir = String(process.env.WORKSPACE_NAV_CAPTURE_DIR || "").trim()
  ? path.resolve(process.env.WORKSPACE_NAV_CAPTURE_DIR)
  : null;
let canonicalProjects = clone(seedProjects);
let activeProjectId = "a";
let activeSessionId = "a-3";
let reorderMode = "success";
let blockNextReorder = false;
let releaseBlockedReorder = null;
let reorderCalls = [];
let switchCalls = [];
let win = null;
let renderProcessFailure = null;
const rendererErrors = [];

const hardTimeout = setTimeout(() => {
  console.error("workspace-navigation: timed out");
  try {
    win?.destroy?.();
  } catch {
    // Best effort cleanup.
  }
  app.exit(1);
  process.exit(1);
}, 120_000);

function finish(code) {
  clearTimeout(hardTimeout);
  try {
    win?.destroy?.();
  } catch {
    // Best effort cleanup.
  }
  app.exit(code);
  setImmediate(() => process.exit(code)).unref?.();
}

function register(channel, value) {
  ipcMain.handle(channel, typeof value === "function" ? value : () => clone(value));
}

async function assertWorkspaceOrderTimingContract() {
  const sourcePath = path.join(root, "src/renderer/modules/workspace-order.js");
  const source = await fs.readFile(sourcePath, "utf8");
  const readConst = (name) => {
    const matches = [...source.matchAll(new RegExp(`^const ${name} = (\\d+);$`, "gm"))];
    assert.equal(matches.length, 1, `${name} must have one top-level numeric declaration`);
    return Number(matches[0][1]);
  };
  assert.equal(readConst("HOLD_MS"), 250, "workspace long press must remain exactly 250ms");
  assert.equal(readConst("HOLD_SLOP_PX"), 4, "workspace long-press slop must remain exactly 4px");
}

function currentState() {
  return {
    projects: clone(canonicalProjects),
    activeProjectId,
    activeSessionId,
    conversation: [],
    runtime: { sessions: {} },
    settings: {},
  };
}

function setCanonicalOrder(ids) {
  const byId = new Map(canonicalProjects.map((project) => [project.id, project]));
  canonicalProjects = ids.map((id) => byId.get(id));
}

function resetCanonical() {
  canonicalProjects = clone(seedProjects);
  activeProjectId = "a";
  activeSessionId = "a-3";
  reorderMode = "success";
  blockNextReorder = false;
  releaseBlockedReorder?.();
  releaseBlockedReorder = null;
  reorderCalls = [];
  switchCalls = [];
}

function waitForMain(predicate, message) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= 5_000) {
        reject(new Error(message));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
}

function releaseReorderGate() {
  const release = releaseBlockedReorder;
  releaseBlockedReorder = null;
  release?.();
}

async function resizeContent(width, height) {
  const bounds = win.getContentBounds();
  if (bounds.width !== width || bounds.height !== height) {
    const resized = new Promise((resolve) => win.once("resize", resolve));
    win.setContentSize(width, height);
    await resized;
  }
  await execute(`
    await window.__workspaceNavigationTest.until(
      () => innerWidth === ${width} && innerHeight === ${height},
      "renderer did not reach ${width}x${height}",
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
}

async function captureEvidence(name) {
  if (!captureDir) return;
  await fs.mkdir(captureDir, { recursive: true });
  const image = await win.webContents.capturePage();
  if (image.isEmpty()) throw new Error(`visual capture ${name} is empty`);
  await fs.writeFile(path.join(captureDir, `${name}.png`), image.toPNG());
}

function projectForSession(sessionId) {
  return canonicalProjects.find((project) =>
    project.sessions.some((session) => session.id === sessionId));
}

function sessionById(project, sessionId) {
  return project?.sessions.find((session) => session.id === sessionId) || null;
}

function registerFixtureIpc() {
  register("app:get-locale", { ok: true, locale: "zh-CN" });
  register("app:get-version", { ok: true, version: "0.0.0-test" });
  register("app:get-edition", { ok: true, id: "domestic", features: {} });
  register("app:get-policy", { ok: true, policy: {} });
  register("app:get-icon-url", { ok: true, url: "" });
  register("assistant:feature-flags", { ok: true, flags: {} });
  register("notifications:get", { ok: true, settings: {} });
  register("state:full", currentState);
  register("session:get-conversation", {
    ok: true,
    conversation: [],
    total: 0,
    hasMore: false,
    nextBefore: 0,
  });
  register("session:get-permission", { ok: true, modeId: "" });
  register("session:get-skills", { ok: true, enabledSkillIds: [] });
  register("session:switch", (_event, sessionId) => {
    const project = projectForSession(sessionId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    activeProjectId = project.id;
    activeSessionId = sessionId;
    switchCalls.push({ type: "session", projectId: project.id, sessionId });
    return {
      ok: true,
      project: clone(project),
      session: clone(sessionById(project, sessionId)),
      conversation: [],
    };
  });
  register("project:switch", (_event, projectId) => {
    const project = canonicalProjects.find((item) => item.id === projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    activeProjectId = project.id;
    const sessions = clone(project.sessions);
    activeSessionId = sessions[0]?.id || "";
    switchCalls.push({ type: "project", projectId, sessionId: activeSessionId });
    return {
      ok: true,
      state: currentState(),
      sessions,
    };
  });
  ipcMain.handle("project:reorder", async (_event, projectIds) => {
    reorderCalls.push([...projectIds]);
    if (blockNextReorder) {
      blockNextReorder = false;
      await new Promise((resolve) => {
        releaseBlockedReorder = resolve;
      });
    }
    if (reorderMode === "throw") throw new Error("FIXTURE_REORDER_FAILED");
    if (reorderMode === "fail") return { ok: false, error: "FIXTURE_REORDER_FAILED" };
    setCanonicalOrder(projectIds);
    return { ok: true, state: currentState() };
  });

  register("scheduled-tasks:list", { ok: true, tasks: [] });
  register("models:list", { ok: true, presets: [], activePresetId: "" });
  register("engine:list", { ok: true, engines: [], activeEngineId: "" });
  register("permissions:list", { ok: true, modes: [], currentMode: "" });
  register("search:list", { ok: true, providers: [], activeProviderId: "" });
  register("media-providers:list", { ok: true, providers: [] });
  register("mail-accounts:list", { ok: true, accounts: [] });
  register("web-credentials:list", { ok: true, credentials: [] });
  register("connectors:list-playbooks", { ok: true, playbooks: [] });
  register("skills:list", { ok: true, groups: [], skills: [] });
  register("skills:check-updates", { ok: true, updates: [] });
  register("skills:get-preset-guide", { ok: true, guide: null });
  register("apps:catalog", { ok: true, json: { apps: [] } });
  register("runtime-packs:list", { ok: true, packs: [] });
  register("runtime-packs:location", { ok: true, path: "" });
  register("runtime-packs:availability", { ok: true, packs: [] });
  register("license:status", { ok: true, status: "active", source: "test" });
  register("updates:get-settings", { ok: true, settings: { autoCheck: false } });
  register("updates:get-state", { ok: true, state: { status: "idle" } });
  register("updates:kick-check", { ok: true, state: { status: "idle" } });
  register("usage:get-summary", { ok: true, summary: {} });
  register("account:status", { ok: true, loggedIn: false });
  register("service:get-settings", { ok: true, settings: {} });
  register("mobile-pairing:status", { ok: true, enabled: false });
}

async function execute(source) {
  return win.webContents.executeJavaScript(`(async () => { ${source} })()`, true);
}

async function refreshRendererFromCanonical() {
  await execute(`
    const { refreshState } = await import("./modules/session-chrome.js");
    const { renderProjectTree } = await import("./modules/project-tree.js");
    document.getElementById("workspaceSwitcherClose")?.click();
    await refreshState();
    renderProjectTree();
    document.getElementById("globalSearch").value = "";
    document.getElementById("globalSearch").dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    document.querySelector(".ctx-menu")?.remove();
    document.querySelectorAll(".toast").forEach((toast) => toast.remove());
    await window.__workspaceNavigationTest.resetOrderController();
  `);
}

function assertCalls(expected, message) {
  assert.deepEqual(reorderCalls, expected, message);
}

function assertNoRendererErrors() {
  if (renderProcessFailure) {
    throw new Error(`renderer process failed: ${JSON.stringify(renderProcessFailure)}`);
  }
  assert.deepEqual(
    rendererErrors,
    [],
    `renderer emitted unexpected errors:\n${rendererErrors.join("\n")}`,
  );
}

registerFixtureIpc();

app.whenReady().then(async () => {
  await assertWorkspaceOrderTimingContract();
  assert(
    seedProjects.some((project) => project.sessions.length === 0),
    "fixture must include a no-session workspace to exercise project:switch",
  );
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(root, "src/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    renderProcessFailure = details;
  });
  win.webContents.on("console-message", (details) => {
    const text = String(details?.message || "");
    const looksUnhandled =
      /\b(?:Uncaught|Unhandled|TypeError|ReferenceError|SyntaxError)\b/i.test(text)
      || text.includes("does not provide an export");
    if (details?.level === "error" || looksUnhandled) {
      rendererErrors.push(
        `${details?.level || "unknown"}:${details?.sourceId || "renderer"}:${text}`,
      );
    }
  });

  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await execute(`
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (predicate, message, timeoutMs = 3000) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        if (predicate()) return;
        await wait(16);
      }
      throw new Error(message);
    };
    const untilAsync = async (predicate, message, timeoutMs = 3000) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        if (await predicate()) return;
        await wait(16);
      }
      throw new Error(message);
    };
    await until(
      () => document.querySelectorAll("#projectTree > .project-group").length === 4,
      "renderer did not initialize four workspaces",
      8000,
    );
    window.__workspaceNavigationTest = {
      wait,
      until,
      untilAsync,
      ids: () => [...document.querySelectorAll(
        "#projectTree > .project-group",
      )].map((group) => group.dataset.projectId),
      storeIds: async () => {
        const store = (await import("./modules/state.js")).default;
        return (store.get("projects") || []).map((project) => project.id);
      },
      group: (id) => document.querySelector(
        '#projectTree > .project-group[data-project-id="' + id + '"]',
      ),
      main: (id) => document.querySelector(
        '.project-header-main[data-project-id="' + id + '"]',
      ),
      handle: (id) => document.querySelector(
        '#projectTree > .project-group[data-project-id="' + id + '"] '
          + ".workspace-drag-handle",
      ),
      more: (id) => document.querySelector(
        '#projectTree > .project-group[data-project-id="' + id + '"] '
          + ".project-action-btn:last-child",
      ),
      pointer(target, type, options = {}) {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: options.pointerId || 1,
          pointerType: options.pointerType || "mouse",
          isPrimary: true,
          button: options.button ?? 0,
          buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
          clientX: options.clientX || 0,
          clientY: options.clientY || 0,
        });
        target.dispatchEvent(event);
        return event;
      },
      async canonicalIds() {
        const state = await window.assistantClient.getFullState();
        return (state.projects || []).map((project) => project.id);
      },
      async resetOrderController() {
        const [
          { initWorkspaceOrder },
          { renderProjectTree },
          { t },
          { showToast, showActionToast },
          stateModule,
        ] = await Promise.all([
          import("./modules/workspace-order.js"),
          import("./modules/project-tree.js"),
          import("./i18n/index.js"),
          import("./modules/toast.js"),
          import("./modules/state.js"),
        ]);
        const store = stateModule.default;
        initWorkspaceOrder({
          getTree: () => document.getElementById("projectTree"),
          getProjects: () => store.get("projects") || [],
          setProjects: (projects) => {
            const focusedId = document.activeElement
              ?.closest?.(".project-group")
              ?.dataset?.projectId;
            store.set("projects", projects);
            renderProjectTree();
            if (focusedId) {
              document.querySelector(
                '.project-header-main[data-project-id="' + focusedId + '"]',
              )?.focus({ preventScroll: true });
            }
          },
          persist: (projectIds) => window.assistantClient.reorderProjects(projectIds),
          isFilterActive: () =>
            document.getElementById("projectTree")?.dataset.filterActive === "true",
          t,
          showToast,
          showActionToast,
        });
      },
    };
  `);

  console.log("[workspace-navigation] sidebar pointer, rollback, and undo");
  const pointerResult = await execute(`
    const h = window.__workspaceNavigationTest;
    const tree = document.getElementById("projectTree");
    const quickMain = h.main("a");
    const beforeQuick = quickMain.getAttribute("aria-expanded");
    quickMain.click();
    const afterQuick = h.main("a").getAttribute("aria-expanded");
    h.main("a").click();
    const afterRestore = h.main("a").getAttribute("aria-expanded");

    const longMain = h.main("a");
    const longRect = longMain.getBoundingClientRect();
    h.pointer(longMain, "pointerdown", {
      pointerId: 11,
      clientX: longRect.left + 8,
      clientY: longRect.top + 8,
    });
    h.pointer(tree, "pointermove", {
      pointerId: 11,
      clientX: longRect.left + 14,
      clientY: longRect.top + 8,
    });
    await h.wait(320);
    h.pointer(tree, "pointerup", {
      pointerId: 11,
      clientX: longRect.left + 14,
      clientY: longRect.top + 8,
    });
    const longPressClean = !document.getElementById("projectTree")
      .classList.contains("workspace-ordering")
      && !document.querySelector(".workspace-order-marker");

    const positiveMain = h.main("a");
    const positiveRect = positiveMain.getBoundingClientRect();
    const holdStartedAt = performance.now();
    let holdObserver = null;
    let holdDeadlineTimer = null;
    const holdActivated = new Promise((resolve) => {
      holdObserver = new MutationObserver(() => {
        if (!tree.classList.contains("workspace-ordering")) return;
        holdObserver.disconnect();
        resolve(performance.now() - holdStartedAt);
      });
      holdObserver.observe(tree, { attributes: true, attributeFilter: ["class"] });
    });
    const holdDeadline = new Promise((_, reject) => {
      holdDeadlineTimer = setTimeout(
        () => reject(new Error("3px long press did not activate before the 340ms deadline")),
        340,
      );
    });
    h.pointer(positiveMain, "pointerdown", {
      pointerId: 12,
      clientX: positiveRect.left + 8,
      clientY: positiveRect.top + 8,
    });
    h.pointer(tree, "pointermove", {
      pointerId: 12,
      clientX: positiveRect.left + 11,
      clientY: positiveRect.top + 8,
    });
    await h.wait(210);
    const orderingBeforeThreshold = tree.classList.contains("workspace-ordering");
    if (orderingBeforeThreshold) {
      clearTimeout(holdDeadlineTimer);
      holdObserver.disconnect();
      throw new Error("3px long press activated before the 210ms checkpoint");
    }
    const holdActivationElapsedMs = await Promise.race([holdActivated, holdDeadline]);
    clearTimeout(holdDeadlineTimer);
    const longPressSourcePresent = h.group("a").classList.contains("is-dragging");
    const longPressMarkerPresent = Boolean(document.querySelector(".workspace-order-marker"));
    tree.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    const longPressEscapeClean = !tree.classList.contains("workspace-ordering")
      && !document.querySelector(".workspace-order-marker")
      && !document.querySelector(".project-group.is-dragging");

    const escapeHandle = h.handle("a");
    const escapeRect = escapeHandle.getBoundingClientRect();
    h.pointer(escapeHandle, "pointerdown", {
      pointerId: 13,
      clientX: escapeRect.left + 4,
      clientY: escapeRect.top + 4,
    });
    const handleOrderingBeforeEscape = tree
      .classList.contains("workspace-ordering");
    tree.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    const handleEscapeClean = !tree
      .classList.contains("workspace-ordering")
      && !document.querySelector(".workspace-order-marker")
      && !document.querySelector(".project-group.is-dragging");

    for (const id of ["a", "b", "c"]) {
      if (h.main(id).getAttribute("aria-expanded") === "true") h.main(id).click();
    }
    const nativeHandle = h.handle("a");
    window.__workspaceNavigationNativeCapture = {
      got: 0,
      lost: 0,
      down: null,
      up: null,
    };
    nativeHandle.addEventListener("gotpointercapture", () => {
      window.__workspaceNavigationNativeCapture.got += 1;
    });
    nativeHandle.addEventListener("lostpointercapture", () => {
      window.__workspaceNavigationNativeCapture.lost += 1;
    });
    tree.addEventListener("pointerdown", (event) => {
      window.__workspaceNavigationNativeCaptureTarget = event.target;
      window.__workspaceNavigationNativeCapture.down = {
        trusted: event.isTrusted,
        hitHandle: event.target.closest?.(".workspace-drag-handle") === nativeHandle,
        pointerId: event.pointerId,
        captured: event.target.hasPointerCapture(event.pointerId),
      };
    }, { once: true });
    tree.addEventListener("pointerup", (event) => {
      window.__workspaceNavigationNativeCapture.up = {
        trusted: event.isTrusted,
        hitHandle: event.target.closest?.(".workspace-drag-handle") === nativeHandle,
        pointerId: event.pointerId,
        captured: window.__workspaceNavigationNativeCaptureTarget
          .hasPointerCapture(event.pointerId),
      };
    }, { once: true });
    const nativeHandleRect = nativeHandle.getBoundingClientRect();
    const nativeLastRect = h.group("d").getBoundingClientRect();
    return {
      beforeQuick,
      afterQuick,
      afterRestore,
      longPressClean,
      orderingBeforeThreshold,
      holdCheckpointMs: 210,
      holdDeadlineMs: 340,
      holdActivationElapsedMs,
      longPressSourcePresent,
      longPressMarkerPresent,
      longPressEscapeClean,
      handleOrderingBeforeEscape,
      handleEscapeClean,
      native: {
        x: Math.round(nativeHandleRect.left + (nativeHandleRect.width / 2)),
        y: Math.round(nativeHandleRect.top + (nativeHandleRect.height / 2)),
        targetY: Math.round(nativeLastRect.bottom - 2),
      },
    };
  `);
  assert.notEqual(pointerResult.beforeQuick, pointerResult.afterQuick, "quick click must toggle collapse");
  assert.equal(pointerResult.beforeQuick, pointerResult.afterRestore, "second quick click must restore collapse");
  assert.equal(pointerResult.longPressClean, true, "movement beyond 4px must cancel long press");
  assert.equal(pointerResult.orderingBeforeThreshold, false, "long press must not start before 250ms");
  assert.equal(pointerResult.holdCheckpointMs, 210);
  assert.equal(pointerResult.holdDeadlineMs, 340);
  assert(
    pointerResult.holdActivationElapsedMs >= pointerResult.holdCheckpointMs,
    `long press activated too early at ${pointerResult.holdActivationElapsedMs}ms`,
  );
  console.log(
    `[workspace-navigation] long press: clear@${pointerResult.holdCheckpointMs}ms, `
      + `active@${Math.round(pointerResult.holdActivationElapsedMs)}ms, `
      + `deadline=${pointerResult.holdDeadlineMs}ms`,
  );
  assert.equal(pointerResult.longPressSourcePresent, true);
  assert.equal(pointerResult.longPressMarkerPresent, true);
  assert.equal(pointerResult.longPressEscapeClean, true);
  assert.equal(pointerResult.handleOrderingBeforeEscape, true, "handle must start ordering immediately");
  assert.equal(pointerResult.handleEscapeClean, true, "Escape must clean immediate handle drag");
  assertCalls([], "click and long-press cancellation scenarios must not persist");

  win.webContents.sendInputEvent({
    type: "mouseMove",
    x: pointerResult.native.x,
    y: pointerResult.native.y,
    movementX: 0,
    movementY: 0,
  });
  await execute(`
    await window.__workspaceNavigationTest.until(
      () => getComputedStyle(window.__workspaceNavigationTest.handle("a")).pointerEvents === "auto",
      "trusted mouse hover did not reveal the drag handle",
    );
  `);
  win.webContents.sendInputEvent({
    type: "mouseDown",
    x: pointerResult.native.x,
    y: pointerResult.native.y,
    button: "left",
    clickCount: 1,
  });
  const trustedPointerDown = await execute(`
    await window.__workspaceNavigationTest.until(
      () => document.getElementById("projectTree").classList.contains("workspace-ordering"),
      "trusted mouseDown did not enter ordering",
    );
    return window.__workspaceNavigationNativeCapture.down;
  `);
  assert.deepEqual(
    trustedPointerDown,
    {
      trusted: true,
      hitHandle: true,
      pointerId: trustedPointerDown?.pointerId,
      captured: true,
    },
    `trusted mouseDown did not capture on the handle: ${JSON.stringify(trustedPointerDown)}`,
  );
  win.webContents.sendInputEvent({
    type: "mouseMove",
    x: pointerResult.native.x,
    y: pointerResult.native.targetY,
    button: "left",
    movementX: 0,
    movementY: pointerResult.native.targetY - pointerResult.native.y,
  });
  win.webContents.sendInputEvent({
    type: "mouseUp",
    x: pointerResult.native.x,
    y: pointerResult.native.targetY,
    button: "left",
    clickCount: 1,
  });
  await waitForMain(
    () => reorderCalls.length === 1,
    "trusted mouse drag did not invoke project:reorder",
  );
  const nativeDragResult = await execute(`
    const h = window.__workspaceNavigationTest;
    await h.untilAsync(
      async () => (await h.canonicalIds()).join(",") === "b,c,d,a"
        && Boolean(document.querySelector(".toast-success .toast-action")),
      "trusted mouse drag did not settle at [b,c,d,a]",
    );
    const sourceAfterDrag = h.main("a");
    const collapsedBeforeSyntheticClick = sourceAfterDrag.getAttribute("aria-expanded");
    sourceAfterDrag.click();
    const collapsedAfterSyntheticClick = h.main("a").getAttribute("aria-expanded");
    return {
      domIds: h.ids(),
      storeIds: await h.storeIds(),
      capture: window.__workspaceNavigationNativeCapture,
      collapsedBeforeSyntheticClick,
      collapsedAfterSyntheticClick,
    };
  `);
  assert.deepEqual(nativeDragResult.domIds, ["b", "c", "d", "a"]);
  assert.deepEqual(nativeDragResult.storeIds, ["b", "c", "d", "a"]);
  assert.deepEqual(
    {
      trusted: nativeDragResult.capture.down.trusted,
      hitHandle: nativeDragResult.capture.down.hitHandle,
      captured: nativeDragResult.capture.down.captured,
    },
    { trusted: true, hitHandle: true, captured: true },
    "trusted drag must hit the handle and acquire pointer capture",
  );
  assert.deepEqual(
    {
      trusted: nativeDragResult.capture.up.trusted,
      samePointer:
        nativeDragResult.capture.up.pointerId === nativeDragResult.capture.down.pointerId,
      captured: nativeDragResult.capture.up.captured,
    },
    { trusted: true, samePointer: true, captured: false },
    "trusted pointerup must finish the captured pointer and release capture",
  );
  assert.equal(
    nativeDragResult.collapsedBeforeSyntheticClick,
    nativeDragResult.collapsedAfterSyntheticClick,
    "post-drag synthetic click must not collapse the source workspace",
  );
  assertCalls([["b", "c", "d", "a"]], "trusted drag must persist one complete order");

  const undoResult = await execute(`
    const h = window.__workspaceNavigationTest;
    const undo = document.querySelector(".toast-success .toast-action");
    undo.click();
    await h.untilAsync(
      async () => h.ids().join(",") === "a,b,c,d"
        && (await h.canonicalIds()).join(",") === "a,b,c,d"
        && !document.querySelector(".toast-success .toast-action"),
      "Undo did not restore [a,b,c,d]",
    );
    return { domIds: h.ids(), storeIds: await h.storeIds() };
  `);
  assert.deepEqual(undoResult.domIds, ["a", "b", "c", "d"]);
  assert.deepEqual(undoResult.storeIds, ["a", "b", "c", "d"]);
  assertCalls(
    [["b", "c", "d", "a"], ["a", "b", "c", "d"]],
    "Undo must persist the complete previous order",
  );

  await execute(`await window.__workspaceNavigationTest.resetOrderController();`);
  reorderMode = "throw";
  blockNextReorder = true;
  reorderCalls = [];
  const optimisticFailure = await execute(`
    const h = window.__workspaceNavigationTest;
    const handle = h.handle("a");
    const handleRect = handle.getBoundingClientRect();
    const lastRect = h.group("d").getBoundingClientRect();
    h.pointer(handle, "pointerdown", {
      pointerId: 14,
      clientX: handleRect.left + 4,
      clientY: handleRect.top + 4,
    });
    h.pointer(document.getElementById("projectTree"), "pointermove", {
      pointerId: 14,
      clientX: handleRect.left + 4,
      clientY: lastRect.bottom + 12,
    });
    h.pointer(document.getElementById("projectTree"), "pointerup", {
      pointerId: 14,
      clientX: handleRect.left + 4,
      clientY: lastRect.bottom + 12,
    });
    await h.until(
      () => h.ids().join(",") === "b,c,d,a",
      "throwing reorder did not paint optimistically",
    );
    return {
      domIds: h.ids(),
      storeIds: await h.storeIds(),
    };
  `);
  await waitForMain(
    () => reorderCalls.length === 1,
    "throwing reorder did not reach the main-process handler",
  );
  assert.deepEqual(optimisticFailure.domIds, ["b", "c", "d", "a"]);
  assert.deepEqual(optimisticFailure.storeIds, ["b", "c", "d", "a"]);
  releaseReorderGate();
  const failureResult = await execute(`
    const h = window.__workspaceNavigationTest;
    await h.until(
      () => h.ids().join(",") === "a,b,c,d"
        && Boolean(document.querySelector(".toast-error")),
      "rejected IPC reorder did not roll back and show an error",
    );
    return {
      domIds: h.ids(),
      storeIds: await h.storeIds(),
      errorText: document.querySelector(".toast-error")?.textContent || "",
    };
  `);
  assert.deepEqual(failureResult.domIds, ["a", "b", "c", "d"]);
  assert.deepEqual(failureResult.storeIds, ["a", "b", "c", "d"]);
  assert(failureResult.errorText.trim(), "failure toast must contain localized text");
  assertCalls([["b", "c", "d", "a"]], "rejected drag must send one complete order");
  reorderMode = "success";
  await execute(`await window.__workspaceNavigationTest.resetOrderController();`);

  console.log("[workspace-navigation] search lock, keyboard ordering, and menu");
  reorderMode = "success";
  reorderCalls = [];
  const filterResult = await execute(`
    const h = window.__workspaceNavigationTest;
    const search = document.getElementById("globalSearch");
    search.value = "Alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const tree = document.getElementById("projectTree");
    const handle = h.handle("a");
    const handleStyle = getComputedStyle(handle);
    const main = h.main("a");
    main.focus();
    main.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    }));
    const rect = handle.getBoundingClientRect();
    h.pointer(handle, "pointerdown", {
      pointerId: 21,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    });
    h.pointer(tree, "pointerup", {
      pointerId: 21,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    });
    const result = {
      filterActive: tree.dataset.filterActive,
      visibility: handleStyle.visibility,
      pointerEvents: handleStyle.pointerEvents,
      ordering: tree.classList.contains("workspace-ordering"),
      ids: h.ids(),
    };
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    return result;
  `);
  assert.equal(filterResult.filterActive, "true");
  assert.equal(filterResult.visibility, "hidden");
  assert.equal(filterResult.pointerEvents, "none");
  assert.equal(filterResult.ordering, false);
  assert.deepEqual(filterResult.ids, ["a", "b", "c", "d"]);
  assertCalls([], "filter mode must suppress keyboard and pointer reordering");

  const keyboardResult = await execute(`
    const h = window.__workspaceNavigationTest;
    const moveDown = async (expectedOrder) => {
      const main = h.main("a");
      main.focus();
      main.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await h.untilAsync(
        async () => document.activeElement === h.main("a")
          && (await h.canonicalIds()).join(",") === expectedOrder,
        "keyboard reorder did not persist " + expectedOrder + " with focus restored",
      );
      return h.ids();
    };
    const first = await moveDown("b,a,c,d");
    const firstFocused = document.activeElement === h.main("a");
    const second = await moveDown("b,c,a,d");
    const secondFocused = document.activeElement === h.main("a");
    return {
      first,
      second,
      firstFocused,
      secondFocused,
      storeIds: await h.storeIds(),
    };
  `);
  assert.deepEqual(keyboardResult.first, ["b", "a", "c", "d"]);
  assert.deepEqual(keyboardResult.second, ["b", "c", "a", "d"]);
  assert.equal(keyboardResult.firstFocused, true);
  assert.equal(keyboardResult.secondFocused, true);
  assert.deepEqual(keyboardResult.storeIds, ["b", "c", "a", "d"]);
  assertCalls(
    [["b", "a", "c", "d"], ["b", "c", "a", "d"]],
    "consecutive Alt+ArrowDown must persist each full order",
  );

  resetCanonical();
  await refreshRendererFromCanonical();
  const menuResult = await execute(`
    const h = window.__workspaceNavigationTest;
    const moreButton = h.more("a");
    if (!moreButton) throw new Error("Workspace A more button is missing");
    moreButton.click();
    const topItems = [...document.querySelectorAll(".ctx-menu-item")];
    if (topItems.length < 4) {
      throw new Error("Workspace menu rendered only " + topItems.length + " items");
    }
    const topBoundary = {
      moveTopDisabled: topItems[1]?.disabled,
      moveUpDisabled: topItems[2]?.disabled,
      moveDownDisabled: topItems[3]?.disabled,
      labels: topItems.slice(1, 4).map((item) => item.textContent.trim()),
    };
    topItems[3].click();
    await h.untilAsync(
      async () => h.ids().join(",") === "b,a,c,d"
        && (await h.canonicalIds()).join(",") === "b,a,c,d",
      "context menu Move Down did not reorder",
    );
    return { topBoundary, ids: h.ids(), storeIds: await h.storeIds() };
  `);
  assert.equal(menuResult.topBoundary.moveTopDisabled, true);
  assert.equal(menuResult.topBoundary.moveUpDisabled, true);
  assert.equal(menuResult.topBoundary.moveDownDisabled, false);
  assert(menuResult.topBoundary.labels.every(Boolean), "menu move actions must be localized");
  assert.deepEqual(menuResult.ids, ["b", "a", "c", "d"]);
  assert.deepEqual(menuResult.storeIds, ["b", "a", "c", "d"]);
  assertCalls([["b", "a", "c", "d"]], "context menu Move Down must persist expected order");

  resetCanonical();
  await refreshRendererFromCanonical();
  const lastBoundary = await execute(`
    const h = window.__workspaceNavigationTest;
    const moreButton = h.more("d");
    if (!moreButton) throw new Error("Workspace D more button is missing");
    moreButton.click();
    const items = [...document.querySelectorAll(".ctx-menu-item")];
    if (items.length < 4) {
      throw new Error("Workspace menu rendered only " + items.length + " items");
    }
    const result = {
      moveTopDisabled: items[1]?.disabled,
      moveUpDisabled: items[2]?.disabled,
      moveDownDisabled: items[3]?.disabled,
    };
    document.querySelector(".ctx-menu")?.remove();
    return result;
  `);
  assert.equal(lastBoundary.moveTopDisabled, false);
  assert.equal(lastBoundary.moveUpDisabled, false);
  assert.equal(lastBoundary.moveDownDisabled, true);

  console.log("[workspace-navigation] Space Center switching and runtime patching");
  setCanonicalOrder(["c", "a", "b", "d"]);
  await refreshRendererFromCanonical();
  const switcherExplore = await execute(`
    const h = window.__workspaceNavigationTest;
    const opener = h.main("a");
    opener.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    const overlay = document.getElementById("workspaceSwitcherOverlay");
    const dialog = document.getElementById("workspaceSwitcherDialog");
    const search = document.getElementById("workspaceSwitcherSearch");
    const content = document.getElementById("workspaceSwitcherContent");
    await h.until(() => !overlay.hidden, "Ctrl+K did not open Space Center");
    const focusedOnOpen = document.activeElement === search;
    const cards = [...content.querySelectorAll(".workspace-switcher-card")];
    const cardOrder = cards.map((card) => card.dataset.projectId);
    const firstCardIdentity = cards[0];
    const dialogBeforePreview = dialog.getBoundingClientRect();
    const initialRecentIds = [...content.querySelectorAll(
      ".workspace-switcher-recent-panel .workspace-switcher-session-row",
    )].map((row) => row.dataset.sessionId);
    content.querySelector(
      '.workspace-switcher-card[data-project-id="d"]',
    ).dispatchEvent(new PointerEvent("pointerenter", {
      bubbles: false,
      pointerType: "mouse",
    }));
    const identityPreserved = content.querySelector(".workspace-switcher-card")
      === firstCardIdentity;
    const hoverRecentIds = [...content.querySelectorAll(
      ".workspace-switcher-recent-panel .workspace-switcher-session-row",
    )].map((row) => row.dataset.sessionId);
    content.querySelector(
      '.workspace-switcher-card[data-project-id="d"]',
    ).dispatchEvent(new FocusEvent("focus"));
    const identityPreservedAfterFocus = content.querySelector(".workspace-switcher-card")
      === firstCardIdentity;
    const focusRecentIds = [...content.querySelectorAll(
      ".workspace-switcher-recent-panel .workspace-switcher-session-row",
    )].map((row) => row.dataset.sessionId);
    const dialogAfterPreview = dialog.getBoundingClientRect();

    search.value = "Workspace Beta";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const workspaceSearchIds = [...content.querySelectorAll(
      '.workspace-switcher-search-workspaces [data-target-type="workspace"]',
    )].map((item) => item.dataset.projectId);
    search.value = "Alpha historical exact";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const sessionSearchIds = [...content.querySelectorAll(
      '.workspace-switcher-search-sessions [data-target-type="session"]',
    )].map((item) => item.dataset.sessionId);
    search.value = "definitely-no-result";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const noResults = Boolean(content.querySelector(".workspace-switcher-no-results"));

    search.value = "Alpha historical exact";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(down);
    const activeDescendant = search.getAttribute("aria-activedescendant");
    const up = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(up);
    const left = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(left);
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(enter);
    await h.until(
      () => overlay.hidden,
      "Enter did not activate the exact session result",
    );
    const store = (await import("./modules/state.js")).default;
    return {
      focusedOnOpen,
      cardOrder,
      identityPreserved,
      identityPreservedAfterFocus,
      initialRecentIds,
      hoverRecentIds,
      focusRecentIds,
      previewTopShift: Math.abs(dialogAfterPreview.top - dialogBeforePreview.top),
      previewHeightShift: Math.abs(dialogAfterPreview.height - dialogBeforePreview.height),
      workspaceSearchIds,
      sessionSearchIds,
      noResults,
      downPrevented: down.defaultPrevented,
      upPrevented: up.defaultPrevented,
      activeDescendant: Boolean(activeDescendant),
      leftPrevented: left.defaultPrevented,
      enterPrevented: enter.defaultPrevented,
      activeProjectId: store.get("activeProjectId"),
      activeSessionId: store.get("activeSessionId"),
      overlayHidden: overlay.hidden,
      focusRestored: document.activeElement === opener,
    };
  `);
  assert.equal(switcherExplore.focusedOnOpen, true);
  assert.deepEqual(switcherExplore.cardOrder, ["c", "a", "b", "d"]);
  assert.equal(switcherExplore.identityPreserved, true);
  assert.equal(switcherExplore.identityPreservedAfterFocus, true);
  assert.deepEqual(switcherExplore.initialRecentIds, ["a-3", "a-2", "a-1"]);
  assert.deepEqual(
    switcherExplore.hoverRecentIds,
    switcherExplore.initialRecentIds,
    "hovering a workspace card must not replace the stable recent-session panel",
  );
  assert.deepEqual(
    switcherExplore.focusRecentIds,
    switcherExplore.initialRecentIds,
    "focusing a workspace card must not replace the stable recent-session panel",
  );
  assert(
    switcherExplore.previewTopShift <= 0.5 && switcherExplore.previewHeightShift <= 0.5,
    `workspace preview changed dialog geometry: ${JSON.stringify(switcherExplore)}`,
  );
  assert.deepEqual(switcherExplore.workspaceSearchIds, ["b"]);
  assert.deepEqual(switcherExplore.sessionSearchIds, ["a-1"]);
  assert.equal(switcherExplore.noResults, true);
  assert.equal(switcherExplore.downPrevented, true);
  assert.equal(switcherExplore.upPrevented, true);
  assert.equal(switcherExplore.activeDescendant, true);
  assert.equal(switcherExplore.leftPrevented, false, "ArrowLeft must remain native in search");
  assert.equal(switcherExplore.enterPrevented, true);
  assert.equal(switcherExplore.activeProjectId, "a");
  assert.equal(switcherExplore.activeSessionId, "a-1");
  assert.equal(switcherExplore.overlayHidden, true);
  assert.equal(switcherExplore.focusRestored, true);
  assert.deepEqual(switchCalls.at(-1), {
    type: "session",
    projectId: "a",
    sessionId: "a-1",
  });

  const switchTargets = await execute(`
    const h = window.__workspaceNavigationTest;
    const button = document.getElementById("workspaceSwitcherBtn");
    const overlay = document.getElementById("workspaceSwitcherOverlay");
    const search = document.getElementById("workspaceSwitcherSearch");
    const content = document.getElementById("workspaceSwitcherContent");
    button.focus();
    button.click();
    const betaCard = content.querySelector(
      '.workspace-switcher-card[data-project-id="b"]',
    );
    betaCard.click();
    await h.until(() => overlay.hidden, "workspace card did not close after switching");
    const store = (await import("./modules/state.js")).default;
    const workspaceActivation = {
      projectId: store.get("activeProjectId"),
      sessionId: store.get("activeSessionId"),
      focusRestored: document.activeElement === button,
    };

    button.click();
    const emptyWorkspace = content.querySelector(
      '.workspace-switcher-card[data-project-id="d"]',
    );
    emptyWorkspace.click();
    await h.until(() => overlay.hidden, "empty workspace card did not close after switching");
    const emptyWorkspaceActivation = {
      projectId: store.get("activeProjectId"),
      sessionId: store.get("activeSessionId"),
      focusRestored: document.activeElement === button,
    };

    button.click();
    search.value = "Gamma early research";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const exactOld = content.querySelector(
      '[data-target-type="session"][data-session-id="c-1"]',
    );
    exactOld.click();
    await h.until(() => overlay.hidden, "session search click did not close");
    const exactActivation = {
      projectId: store.get("activeProjectId"),
      sessionId: store.get("activeSessionId"),
    };

    button.click();
    const targets = [...content.querySelectorAll(
      ".workspace-switcher-target:not([disabled])",
    )];
    const last = targets.at(-1);
    search.focus();
    search.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    const shiftTabWrapped = document.activeElement === last;
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }));
    const tabWrapped = document.activeElement === search;
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    return {
      workspaceActivation,
      emptyWorkspaceActivation,
      exactActivation,
      shiftTabWrapped,
      tabWrapped,
      escapeClosed: overlay.hidden,
      escapeFocusRestored: document.activeElement === button,
    };
  `);
  assert.deepEqual(switchTargets.workspaceActivation, {
    projectId: "b",
    sessionId: "b-3",
    focusRestored: true,
  });
  assert.deepEqual(switchTargets.emptyWorkspaceActivation, {
    projectId: "d",
    sessionId: "",
    focusRestored: true,
  });
  assert.deepEqual(switchTargets.exactActivation, {
    projectId: "c",
    sessionId: "c-1",
  });
  assert.equal(switchTargets.shiftTabWrapped, true);
  assert.equal(switchTargets.tabWrapped, true);
  assert.equal(switchTargets.escapeClosed, true);
  assert.equal(switchTargets.escapeFocusRestored, true);
  assert(
    switchCalls.some((call) =>
      call.type === "project" && call.projectId === "d" && call.sessionId === ""),
    "empty workspace activation must exercise project:switch",
  );

  const runtimePatch = await execute(`
    const h = window.__workspaceNavigationTest;
    const button = document.getElementById("workspaceSwitcherBtn");
    const search = document.getElementById("workspaceSwitcherSearch");
    const content = document.getElementById("workspaceSwitcherContent");
    button.click();
    search.value = "Alpha latest handoff";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }));
    const activeBefore = search.getAttribute("aria-activedescendant");
    const status = content.querySelector(
      '.workspace-switcher-session-status[data-session-id="a-3"]',
    );
    const beforeStatus = status.dataset.status;
    const { applyRuntimeBatch } = await import("./modules/session-runtime-store.js");
    applyRuntimeBatch({
      sessionId: "a-3",
      batchSeq: 901,
      events: [{
        sessionId: "a-3",
        turnId: "turn-navigation-test",
        seq: 901,
        type: "turn.started",
        ts: Date.now(),
        payload: {},
      }],
    });
    await h.until(
      () => status.dataset.status === "running",
      "runtime status did not patch to running",
    );
    const result = {
      sameNode: content.querySelector(
        '.workspace-switcher-session-status[data-session-id="a-3"]',
      ) === status,
      beforeStatus,
      afterStatus: status.dataset.status,
      className: status.className,
      text: status.textContent,
      query: search.value,
      activePreserved: search.getAttribute("aria-activedescendant") === activeBefore,
    };
    document.getElementById("workspaceSwitcherClose").click();
    return result;
  `);
  assert.equal(runtimePatch.sameNode, true, "runtime update must patch the existing status node");
  assert.equal(runtimePatch.beforeStatus, "idle");
  assert.equal(runtimePatch.afterStatus, "running");
  assert(runtimePatch.className.includes("is-running"));
  assert(runtimePatch.text.trim(), "runtime status must keep localized text");
  assert.equal(runtimePatch.query, "Alpha latest handoff");
  assert.equal(runtimePatch.activePreserved, true);

  console.log("[workspace-navigation] computed layout and responsive grid");
  await resizeContent(1280, 720);
  const desktopLayout = await execute(`
    const h = window.__workspaceNavigationTest;
    const shell = document.getElementById("appShell");
    shell.style.setProperty("--left-w", "180px");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const main = h.main("a");
    const handle = h.handle("a");
    const actions = h.group("a").querySelector(".project-actions");
    const navigationCss = await fetch("./styles/workspace-navigation.css")
      .then((response) => response.text());
    const focusRuleExists =
      /\\.project-header-main:focus-visible\\s*\\{[^}]*outline\\s*:/s.test(navigationCss)
      && /\\.workspace-switcher-btn:focus-visible[\\s\\S]*?outline\\s*:/s.test(navigationCss);
    document.documentElement.dir = "ltr";
    document.getElementById("workspaceSwitcherBtn").click();
    const dialog = document.getElementById("workspaceSwitcherDialog");
    const grid = document.querySelector(".workspace-switcher-grid");
    const dialogRect = dialog.getBoundingClientRect();
    const handleStyle = getComputedStyle(handle);
    const desktopColumns = getComputedStyle(grid).gridTemplateColumns
      .split(" ").filter(Boolean).length;
    return {
      mainWidth: main.getBoundingClientRect().width,
      handlePosition: handleStyle.position,
      handleLeft: handleStyle.left,
      handleRight: handleStyle.right,
      actionsPosition: getComputedStyle(actions).position,
      focusRuleExists,
      desktopColumns,
      dialogWithinViewport: dialogRect.left >= -0.5
        && dialogRect.right <= innerWidth + 0.5
        && dialogRect.top >= -0.5
        && dialogRect.bottom <= innerHeight + 0.5,
    };
  `);
  await captureEvidence("desktop-ltr");
  assert(desktopLayout.mainWidth >= 80, `180px sidebar left only ${desktopLayout.mainWidth}px`);
  assert.equal(desktopLayout.handlePosition, "absolute");
  assert.equal(desktopLayout.actionsPosition, "absolute");
  assert.equal(desktopLayout.focusRuleExists, true);
  assert.equal(desktopLayout.desktopColumns, 3);
  assert.equal(desktopLayout.dialogWithinViewport, true);

  const rtlLayout = await execute(`
    document.documentElement.dir = "rtl";
    document.documentElement.style.setProperty("direction", "ltr", "important");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const card = document.querySelector(".workspace-switcher-card");
    const meta = document.querySelector(".workspace-switcher-card-meta");
    const forcedCardStyle = getComputedStyle(card);
    const forcedMetaStyle = getComputedStyle(meta);
    const explicitRule = {
      cardDirection: forcedCardStyle.direction,
      cardTextAlign: forcedCardStyle.textAlign,
      metaDirection: forcedMetaStyle.direction,
      metaFlexDirection: forcedMetaStyle.flexDirection,
    };
    document.documentElement.style.removeProperty("direction");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const handleStyle = getComputedStyle(
      window.__workspaceNavigationTest.handle("a"),
    );
    return {
      ...explicitRule,
      handleLeft: handleStyle.left,
      handleRight: handleStyle.right,
    };
  `);
  await captureEvidence("desktop-rtl");
  assert.equal(rtlLayout.cardDirection, "rtl");
  assert.equal(rtlLayout.cardTextAlign, "start");
  assert.equal(rtlLayout.metaDirection, "rtl");
  assert.notEqual(rtlLayout.metaFlexDirection, "row-reverse");
  assert.notEqual(desktopLayout.handleRight, "auto");
  assert.notEqual(rtlLayout.handleLeft, "auto");
  assert.notEqual(
    `${desktopLayout.handleLeft}:${desktopLayout.handleRight}`,
    `${rtlLayout.handleLeft}:${rtlLayout.handleRight}`,
    "RTL must flip the drag handle logical inline-end positioning",
  );

  await execute(`document.documentElement.dir = "ltr";`);
  await resizeContent(390, 844);
  const mobileLayout = await execute(`
    const dialog = document.getElementById("workspaceSwitcherDialog");
    const grid = document.querySelector(".workspace-switcher-grid");
    const rect = dialog.getBoundingClientRect();
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      left: rect.left,
      right: rect.right,
      innerWidth,
      noHorizontalOverflow: rect.left >= -0.5 && rect.right <= innerWidth + 0.5,
    };
  `);
  await captureEvidence("mobile");
  assert.equal(mobileLayout.columns, 1);
  assert.equal(
    mobileLayout.noHorizontalOverflow,
    true,
    `mobile dialog overflowed: ${JSON.stringify(mobileLayout)}`,
  );

  await execute(`
    document.getElementById("workspaceSwitcherClose").click();
    document.getElementById("appShell").style.removeProperty("--left-w");
    document.documentElement.dir = "ltr";
    document.getElementById("globalSearch").value = "";
    document.getElementById("globalSearch").dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    document.querySelectorAll(".toast, .ctx-menu").forEach((element) => element.remove());
  `);
  resetCanonical();
  assertNoRendererErrors();

  console.log("workspace-navigation: ok");
  finish(0);
}).catch(async (error) => {
  let diagnostics = null;
  try {
    diagnostics = await execute(`
      const store = (await import("./modules/state.js")).default;
      return {
        domOrder: window.__workspaceNavigationTest?.ids?.() || [],
        storeOrder: (store.get("projects") || []).map((project) => project.id),
        activeProjectId: store.get("activeProjectId"),
        activeSessionId: store.get("activeSessionId"),
        filterActive: document.getElementById("projectTree")?.dataset.filterActive,
        ordering: document.getElementById("projectTree")?.classList.contains(
          "workspace-ordering",
        ),
        switcherOpen: !document.getElementById("workspaceSwitcherOverlay")?.hidden,
        toasts: [...document.querySelectorAll(".toast")].map((toast) => toast.textContent),
      };
    `);
  } catch {
    // Renderer may already be unavailable.
  }
  console.error(error?.stack || error?.message || error);
  console.error("workspace-navigation diagnostics:", JSON.stringify({
    canonicalOrder: canonicalProjects.map((project) => project.id),
    reorderMode,
    reorderCalls,
    switchCalls,
    rendererErrors,
    renderProcessFailure,
    renderer: diagnostics,
  }));
  finish(1);
});
