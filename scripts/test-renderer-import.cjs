#!/usr/bin/env node
"use strict";

const electron = require("electron");
const { app, BrowserWindow, ipcMain } = electron;
const path = require("node:path");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error("test-renderer-import must run under Electron. Use: npx electron scripts/test-renderer-import.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
const capturedQuestionResponses = [];
const capturedRevealPaths = [];
const capturedOpenPaths = [];
const capturedAccountLoginPayloads = [];
const delayedMediaStatusCalls = new Map();
let win;

const hardTimeout = setTimeout(() => {
  console.error("test-renderer-import: timed out");
  try {
    win?.destroy?.();
  } catch {
    // Best effort test cleanup.
  }
  app.exit(1);
  process.exit(1);
}, Number(process.env.TEST_RENDERER_IMPORT_TIMEOUT_MS || 180000));

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

function makeTinyPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    [
      "3 0 obj",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160]",
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "endobj\n",
    ].join("\n"),
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 18 Tf 48 90 Td (Hello PDF) Tj ET\nendstream\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8").toString("base64");
}

ipcMain.handle("assistant:question-response", (_event, payload) => {
  capturedQuestionResponses.push(payload);
  return { ok: true };
});

ipcMain.handle("filetree:reveal", (_event, payload) => {
  capturedRevealPaths.push(`${payload?.sessionId || ""}:${payload?.filePath || ""}`);
  return { ok: true };
});

ipcMain.handle("filetree:open", (_event, payload) => {
  capturedOpenPaths.push(`${payload?.sessionId || ""}:${payload?.filePath || ""}`);
  return { ok: true };
});

ipcMain.handle("files:read-text", (_event, payload) => {
  if (String(payload?.filePath || "").endsWith("report.md")) {
    return {
      ok: true,
      text: [
        "# Markdown Report",
        "",
        "正文和 `inline code`。",
        "",
        "| 项目 | 内容 |",
        "| --- | --- |",
        "| 城市 | Dubai |",
        "",
        "![Local chart](./report-assets.png)",
        "",
        "---",
        "",
        "- 要点",
      ].join("\n"),
      bytes: 96,
      truncated: false,
    };
  }
  return { ok: false, error: "NOT_FOUND" };
});

ipcMain.handle("files:local-media-status", (_event, payload) => {
  const filePath = String(payload?.filePath || "");
  if (filePath.includes("unauthorized-image.png")) {
    return { ok: false, error: "NOT_AUTHORIZED", path: filePath, exists: true, authorized: false };
  }
  if (/generated-assets[/\\]delayed-[^/\\]+\.png$/i.test(filePath)) {
    const count = (delayedMediaStatusCalls.get(filePath) || 0) + 1;
    delayedMediaStatusCalls.set(filePath, count);
    if (count === 1) {
      return { ok: false, error: "NOT_FOUND", path: filePath, exists: false, authorized: true };
    }
    return { ok: true, error: "", path: filePath, exists: true, authorized: true, url: `app-file://media/${encodeURIComponent(filePath)}` };
  }
  if (filePath.includes("generated-assets/image-stale.png")) {
    const recovered = "/tmp/generated-assets/scene1.png";
    return { ok: true, error: "", path: recovered, originalPath: filePath, recovered: true, exists: true, authorized: true, url: `app-file://media/${encodeURIComponent(recovered)}` };
  }
  return { ok: true, error: "", path: filePath, exists: true, authorized: true, url: `app-file://media/${encodeURIComponent(filePath)}` };
});

ipcMain.handle("scheduled-tasks:list", (_event, filter = {}) => {
  if (filter?.sessionId) return { ok: true, tasks: [] };
  const allScope = filter?.projectId === null && filter?.sessionId === null;
  const workspaceScope = filter?.projectId === "p_sched" && filter?.sessionId === null;
  const title = allScope ? "Global task" : workspaceScope ? "Workspace task" : "Unexpected scope";
  return {
    ok: true,
    tasks: [
      {
        id: "sched_workspace",
        projectId: "p_sched",
        sessionId: "s_sched_a",
        title,
        scheduleText: "每天 09:00",
        enabled: true,
        status: "scheduled",
        nextRunAt: "2026-06-24T09:00:00.000Z",
      },
    ],
  };
});

ipcMain.handle("scheduled-tasks:run-now", () => ({ ok: true }));
ipcMain.handle("scheduled-tasks:set-enabled", () => ({ ok: true }));
ipcMain.handle("scheduled-tasks:remove", () => ({ ok: true }));
ipcMain.handle("session:switch", (_event, sessionId) => {
  return { ok: true, conversation: [], session: { id: sessionId, title: "Alpha chat" } };
});
ipcMain.handle("session:get-conversation", async (_event, payload) => {
  const sessionId = typeof payload === "string" ? payload : payload?.sessionId || "";
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (sessionId === "session_switch_slow_a") {
    await delay(120);
    return {
      ok: true,
      conversation: [{ id: "slow_a_msg", role: "user", content: "slow A should not win" }],
      total: 1,
      hasMore: false,
      nextBefore: 0,
    };
  }
  if (sessionId === "session_switch_fast_b") {
    await delay(5);
    return {
      ok: true,
      conversation: [{ id: "fast_b_msg", role: "user", content: "fast B wins" }],
      total: 1,
      hasMore: false,
      nextBefore: 0,
    };
  }
  return { ok: true, conversation: [], total: 0, hasMore: false, nextBefore: 0 };
});

ipcMain.handle("app:get-locale", () => ({ ok: true, locale: "zh-CN" }));
ipcMain.handle("app:get-version", () => ({ ok: true, version: "0.0.0-test" }));
ipcMain.handle("app:get-edition", () => ({ ok: true, id: "domestic", features: { account: true } }));
ipcMain.handle("app:get-icon-url", () => ({ ok: true, url: "" }));
ipcMain.handle("account:status", () => ({
  ok: true,
  loggedIn: true,
  user: { phoneE164: "+8618210178959" },
  entitlements: {
    tokenBalance: 100000,
    imageGenerationsRemaining: 3,
    videoGenerationsRemaining: 1,
    membershipExpiresAt: null,
  },
}));
ipcMain.handle("account:sms-login", (_event, payload) => {
  capturedAccountLoginPayloads.push(payload);
  return { ok: false, error: "TEST_STOP" };
});
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
ipcMain.handle("state:full", () => ({
  ok: true,
  state: {
    workspaces: [],
    sessions: [],
    activeSessionId: "",
    settings: {},
  },
}));

ipcMain.handle("apps:catalog", () => ({
  ok: true,
  json: {
    apps: [
      {
        id: "stock-starter",
        name: "Stock Starter",
        latestVersion: "1.0.0",
        category: "finance",
        appType: "dashboard",
        riskLevel: "medium",
        sizeBytes: 1024,
        summary: "A stock analysis workspace app",
        downloadUrl: "https://cdn.example.com/stock.zip",
        installed: false,
        requiredRuntimePacks: [],
        requiredSkillPackages: [],
        tags: [],
      },
      {
        id: "installed-app",
        name: "Installed App",
        latestVersion: "1.0.0",
        category: "finance",
        appType: "dashboard",
        riskLevel: "low",
        sizeBytes: 2048,
        summary: "An installed workspace app",
        installed: true,
        installedAvailable: true,
        installedPath: "/tmp/Lily Apps/Installed App",
        installedCount: 2,
        updateAvailable: false,
        requiredRuntimePacks: [],
        requiredSkillPackages: [],
        tags: [],
      },
    ],
  },
}));

app.whenReady().then(async () => {
  const tinyPdfBase64 = makeTinyPdf();
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
  await new Promise((r) => setTimeout(r, 1500));
  const result = await win.webContents.executeJavaScript(`(
    async () => {
      const results = [];
      for (const spec of [
        "./modules/engine-notice-policy.js",
        "./modules/tool-payload-renderer.js",
        "./modules/turn-block-renderers.js",
        "./modules/pdf-core.js",
        "./modules/pdf-viewer.js",
        "./modules/turn-view-renderer.js",
        "./modules/session-runtime-store.js",
        "./modules/task-center.js",
        "./modules/message.js",
        "./modules/workbench-empty.js",
        "./app.js",
      ]) {
        try {
          await import(spec);
          results.push(spec + ": ok");
        } catch (e) {
          results.push(spec + ": FAIL " + e.message);
        }
      }
      return results.join("\\n");
    }
  )()`);
  console.log(result);
  if (result.includes("FAIL")) {
    app.exitCode = 1;
  } else {
    const skillSettingsPresetResult = await win.webContents.executeJavaScript(`(
      () => {
        const page = document.getElementById("settingsPageSkills");
        if (!page) throw new Error("skills settings page should exist");
        if (page.querySelector("#skillsPresetList, .skills-preset-list, .skills-preset-card")) {
          throw new Error("skills settings should not show capability pack preset cards");
        }
        return "skill-settings-no-preset-cards: ok";
      }
    )()`);
    console.log(skillSettingsPresetResult);
    const appShellCoverageResult = await win.webContents.executeJavaScript(`(
      () => {
        const shell = document.getElementById("appShell");
        if (!shell) throw new Error("app shell should exist");
        const rect = shell.getBoundingClientRect();
        if (Math.abs(rect.bottom - window.innerHeight) > 1) {
          throw new Error("app shell should cover the full window height, bottom=" + rect.bottom + " viewport=" + window.innerHeight);
        }
        const bg = getComputedStyle(document.body).backgroundColor;
        if (!bg || bg === "rgba(0, 0, 0, 0)") {
          throw new Error("body background should be opaque so host windows cannot bleed through");
        }
        return "app-shell-coverage: ok";
      }
    )()`);
    console.log(appShellCoverageResult);
    const taskCenterResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { buildTaskCenterItems } = await import("./modules/task-center.js");
        const items = buildTaskCenterItems({
          activeSessionId: "s_active",
          projects: [
            {
              id: "p1",
              name: "Alpha",
              path: "/tmp/Alpha",
              sessions: [
                { id: "s_run", title: "Running task" },
                { id: "s_done", title: "Done task" },
                { id: "s_fail", title: "Failed task" },
              ],
            },
          ],
          runtimes: [
            {
              sessionId: "s_done",
              phase: "idle",
              attention: "done",
              queue: [],
              liveTurn: { artifacts: [{ path: "/tmp/report.md" }], assistantText: "report ready" },
            },
            {
              sessionId: "s_run",
              phase: "tool_running",
              queue: [{ id: "q1" }],
              liveTurn: { startedAt: 10, questions: new Map(), permissions: new Map(), hooks: new Map() },
            },
            {
              sessionId: "s_fail",
              phase: "idle",
              attention: "failed",
              queue: [],
              liveTurn: { assistantText: "network interrupted" },
            },
            {
              sessionId: "s_idle",
              phase: "idle",
              attention: null,
              queue: [],
              liveTurn: null,
            },
          ],
        });
        if (items.length !== 3) throw new Error("expected 3 actionable task-center items, got " + items.length);
        if (items[0].status !== "failed") throw new Error("failed item should be first, got " + items[0].status);
        const running = items.find((item) => item.sessionId === "s_run");
        if (!running || running.status !== "running" || running.queueCount !== 1) {
          throw new Error("running queued item not summarized correctly");
        }
        const done = items.find((item) => item.sessionId === "s_done");
        if (!done || done.artifactCount !== 1 || done.projectLabel !== "Alpha") {
          throw new Error("completed artifact item not summarized correctly");
        }
        return "task-center-summary: ok";
      }
    )()`);
    console.log(taskCenterResult);
    const taskCenterDomStabilityResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { getRuntimeSession } = await import("./modules/session-runtime-store.js");
        const { renderTaskCenter } = await import("./modules/task-center.js");
        const originalProjects = store.get("projects");
        const originalActiveSessionId = store.get("activeSessionId");
        const sessionId = "s_task_center_dom_stability";
        store.set("projects", [
          {
            id: "p_task_center",
            name: "Task Center",
            path: "/tmp/TaskCenter",
            sessions: [{ id: sessionId, title: "Running task" }],
          },
        ]);
        store.set("activeSessionId", "");
        const runtime = getRuntimeSession(sessionId);
        runtime.phase = "tool_running";
        runtime.attention = null;
        runtime.queue = [];
        runtime.liveTurn = {
          turnId: "turn_task_center_dom_stability",
          startedAt: 10,
          updatedAt: 10,
          assistantText: "working",
          questions: new Map(),
          permissions: new Map(),
          hooks: new Map(),
        };
        const panel = document.getElementById("taskCenterPanel");
        if (!panel) throw new Error("task center panel should exist");
        panel.hidden = false;
        renderTaskCenter();
        const firstNode = panel.firstElementChild;
        if (!firstNode) throw new Error("task center should render the running item");
        runtime.liveTurn.updatedAt = 11;
        runtime.liveTurn.assistantText = "working with more streamed text";
        renderTaskCenter();
        if (panel.firstElementChild !== firstNode) {
          throw new Error("running task center item should not be replaced when visible fields are unchanged");
        }
        runtime.phase = "idle";
        runtime.attention = null;
        runtime.liveTurn = null;
        store.set("projects", originalProjects);
        store.set("activeSessionId", originalActiveSessionId);
        renderTaskCenter();
        return "task-center-dom-stability: ok";
      }
    )()`);
    console.log(taskCenterDomStabilityResult);
    const scheduledTaskScopeResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { refreshScheduledTaskList } = await import("./modules/scheduled-tasks.js");
        store.set("projects", [
          {
            id: "p_sched",
            name: "Schedule Workspace",
            path: "/tmp/Schedule Workspace",
            sessions: [
              { id: "s_sched_a", title: "Alpha chat" },
              { id: "s_sched_b", title: "Beta chat" },
            ],
          },
          {
            id: "p_other",
            name: "Other Workspace",
            path: "/tmp/Other Workspace",
            sessions: [{ id: "s_other", title: "Other chat" }],
          },
        ]);
        store.set("activeProjectId", "p_sched");
        store.set("activeSessionId", "s_sched_b");
        document.querySelector('[data-scheduled-scope="workspace"]').checked = true;
        await refreshScheduledTaskList();
        if (!document.querySelector("#scheduledTaskList")?.textContent.includes("Workspace task")) {
          throw new Error("scheduled tasks should default to current workspace scope");
        }
        const item = document.querySelector("#scheduledTaskList .scheduled-task-item");
        if (!item || !item.textContent.includes("Alpha chat") || !item.textContent.includes("Schedule Workspace")) {
          throw new Error("scheduled task should show owning workspace and chat");
        }
        const open = item.querySelector('[data-action="open-session"]');
        if (!open) throw new Error("scheduled task should expose open-session action");
        open.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (store.get("activeSessionId") !== "s_sched_a") throw new Error("open-session should switch to owning chat");
        document.querySelector('[data-scheduled-scope="all"]').checked = true;
        document.querySelector('[data-scheduled-scope="all"]').dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (!document.querySelector("#scheduledTaskList")?.textContent.includes("Global task")) {
          throw new Error("all scheduled tasks scope should request all tasks");
        }
        return "scheduled-task-scope: ok";
      }
    )()`);
    console.log(scheduledTaskScopeResult);
    const liveTurnQueueResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const queueArea = document.getElementById("messageQueueArea");
        const composerRow = document.querySelector("#composer .composer-row");
        if (!queueArea || !composerRow || queueArea.compareDocumentPosition(composerRow) !== Node.DOCUMENT_POSITION_FOLLOWING) {
          throw new Error("message queue area should sit above the composer input row");
        }
        const liveTurn = {
          turnId: "turn_queue_regression",
          phase: "tool_running",
          assistantText: "正在处理",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [],
          notices: [],
          permissions: new Map(),
          questions: new Map(),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, {
          sessionId: "session_queue_regression",
          queue: [{ id: "queue_1", text: "这条待发送不能出现在任务正文里" }],
        });
        if (article.textContent.includes("这条待发送不能出现在任务正文里")) {
          throw new Error("queued messages leaked into live turn article");
        }
        if (article.querySelector("[data-role='queue']")) {
          throw new Error("live turn article should not own queue UI");
        }
        return "live-turn-queue-regression: ok";
      }
    )()`);
    console.log(liveTurnQueueResult);
    const workProgressNoticeResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const liveTurn = {
          turnId: "turn_work_progress",
          phase: "tool_running",
          assistantText: "",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [{
            kind: "notice",
            code: "workProgress",
            level: "progress",
            detail: "Download: 42% · 84 MB / 200 MB",
            progress: { phase: "downloading", percent: 42, writtenBytes: 84 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 },
          }],
          notices: [],
          permissions: new Map(),
          questions: new Map(),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "session_work_progress" });
        const progress = article.querySelector(".assistant-process-notice.is-progress .assistant-process-progress-track");
        if (!progress) throw new Error("workProgress notice should render a progressbar in the chat process area");
        if (progress.getAttribute("aria-valuenow") !== "42") {
          throw new Error("progressbar should carry structured percent");
        }
        const fill = progress.querySelector(".assistant-process-progress-fill");
        if (!fill || fill.style.width !== "42%") throw new Error("progress fill width should reflect percent");
        return "work-progress-notice-regression: ok";
      }
    )()`);
    console.log(workProgressNoticeResult);
    const zeroOnlyProgressNoticeResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const liveTurn = {
          turnId: "turn_zero_only_progress",
          phase: "tool_running",
          assistantText: "",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [{
            kind: "notice",
            code: "workProgress",
            level: "progress",
            detail: "Progress",
            progress: { label: "Progress", percent: 0 },
          }],
          notices: [],
          permissions: new Map(),
          questions: new Map(),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "session_zero_only_progress" });
        if (article.querySelector(".assistant-process-progress-track")) {
          throw new Error("zero-only progress should not render a stuck 0% progressbar");
        }
        if (!article.textContent.includes("Progress")) {
          throw new Error("zero-only progress should still show the activity label");
        }
        return "zero-only-progress-notice-regression: ok";
      }
    )()`);
    console.log(zeroOnlyProgressNoticeResult);
    const minimapResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { updateMinimap } = await import("./modules/conversation-minimap.js");
        // Build a stack > panel(scroller) > list with 2 prompts + 2 answers (h1+h2 each).
        const stack = document.createElement("div");
        stack.className = "session-messages-stack";
        const panel = document.createElement("div");
        panel.className = "session-messages is-active";
        panel.style.cssText = "position:relative;height:300px;overflow:auto";
        const list = document.createElement("div");
        list.className = "messages";
        panel.appendChild(list);
        stack.appendChild(panel);
        document.body.appendChild(stack);
        const addUser = (txt) => {
          const a = document.createElement("article"); a.className = "runtime-user-message";
          const b = document.createElement("div"); b.className = "runtime-user-body"; b.textContent = txt;
          a.appendChild(b); a.style.minHeight = "200px"; list.appendChild(a);
        };
        const addAssistant = (txt) => {
          const a = document.createElement("article"); a.className = "assistant-turn-article";
          const md = document.createElement("div"); md.className = "markdown-body";
          const h1 = document.createElement("h1"); h1.textContent = txt + " 标题";
          const h2 = document.createElement("h2"); h2.textContent = txt + " 小节";
          const p = document.createElement("p"); p.textContent = txt;
          md.append(h1, h2, p); a.appendChild(md); a.style.minHeight = "400px"; list.appendChild(a);
        };
        addUser("第一个问题"); addAssistant("第一个回答");
        addUser("第二个问题"); addAssistant("第二个回答");
        addUser("第三个问题"); addAssistant("第三个回答");
        addUser("第四个问题"); addAssistant("第四个回答");
        updateMinimap(panel);
        const rail = stack.querySelector(".conversation-minimap");
        if (!rail) throw new Error("minimap rail not mounted");
        const ribs = rail.querySelectorAll(".conversation-minimap-rib");
        // Questions only — answers get NO ticks (scope "prompts"); + terminus.
        if (ribs.length !== 5) throw new Error("expected 5 ribs (4 prompt + terminus), got " + ribs.length);
        if (rail.querySelectorAll(".conversation-minimap-rib.is-prompt").length !== 4) throw new Error("expected 4 prompt ribs");
        if (rail.querySelectorAll(".conversation-minimap-rib.is-response").length !== 0) throw new Error("answers must NOT get ticks");
        if (rail.querySelectorAll(".conversation-minimap-rib.is-heading").length !== 0) throw new Error("answers must NOT explode into heading sub-ticks");
        if (rail.querySelector(".conversation-minimap-controls")) throw new Error("scope/depth controls were removed — should not render");
        const terminus = rail.querySelector(".conversation-minimap-rib.is-terminus");
        if (!terminus || terminus !== ribs[ribs.length - 1]) throw new Error("terminus must be the last rib");
        // Clicking a rib must not throw and should request a scroll.
        const scrollCalls = [];
        panel.scrollTo = function(opts, maybeTop) {
          const top = typeof opts === "object" ? Number(opts.top || 0) : Number(maybeTop || 0);
          scrollCalls.push({ top });
          panel.scrollTop = top;
        };
        panel.scrollTop = panel.scrollHeight;
        ribs[0].click();
        if (!scrollCalls.length || scrollCalls[0].top > 30) {
          throw new Error("clicking a DOM-sourced prompt rib must scroll to that prompt");
        }
        if (panel.dataset.userScrollDetached !== "1") {
          throw new Error("clicking an older minimap rib must detach live auto-follow");
        }
        terminus.click();
        const latestTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
        if (panel.scrollTop < latestTop - 1) {
          throw new Error("clicking terminus must scroll to latest");
        }
        if (panel.dataset.userScrollDetached === "1") {
          throw new Error("clicking terminus must resume live auto-follow");
        }
        // Prompt ticks must carry the question text for the hover preview.
        if (!Array.from(ribs).some((r) => (r.getAttribute("aria-label") || "").includes("问题"))) {
          throw new Error("prompt ribs must carry the question text");
        }
        stack.remove();

        // Real runtime path: minimap items are data-sourced and carry turnId.
        // If the target is already rendered, clicking must use the local panel
        // scroll directly instead of delegating to history loading.
        const dataStack = document.createElement("div");
        dataStack.className = "session-messages-stack";
        const dataPanel = document.createElement("div");
        dataPanel.className = "session-messages is-active";
        dataPanel.style.cssText = "position:relative;height:300px;overflow:auto";
        const dataList = document.createElement("div");
        dataList.className = "messages";
        dataPanel.appendChild(dataList);
        dataStack.appendChild(dataPanel);
        document.body.appendChild(dataStack);
        for (let i = 1; i <= 4; i += 1) {
          const a = document.createElement("article");
          a.className = "runtime-user-message";
          a.dataset.turnId = "turn-" + i;
          const b = document.createElement("div");
          b.className = "runtime-user-body";
          b.textContent = "数据问题 " + i;
          a.appendChild(b);
          a.style.minHeight = "220px";
          dataList.appendChild(a);
        }
        const dataScrollCalls = [];
        dataPanel.scrollTo = function(opts, maybeTop) {
          const top = typeof opts === "object" ? Number(opts.top || 0) : Number(maybeTop || 0);
          dataScrollCalls.push({ top });
          dataPanel.scrollTop = top;
        };
        let delegatedJump = "";
        updateMinimap(dataPanel, {
          items: [1, 2, 3, 4].map((i) => ({ role: "user", turnId: "turn-" + i, label: "数据问题 " + i })),
          jumpToTurn: (turnId) => { delegatedJump = turnId; },
        });
        const dataRibs = dataStack.querySelectorAll(".conversation-minimap-rib");
        if (dataRibs.length !== 5) throw new Error("expected data-sourced ribs plus terminus");
        dataPanel.scrollTop = dataPanel.scrollHeight;
        dataRibs[0].click();
        if (delegatedJump) throw new Error("rendered turnId rib should not delegate to history loading: " + delegatedJump);
        if (!dataScrollCalls.length || dataScrollCalls[0].top > 30) {
          throw new Error("clicking a data-sourced rendered rib must scroll the panel");
        }
        if (dataPanel.dataset.userScrollDetached !== "1") {
          throw new Error("data-sourced rendered rib must detach live auto-follow");
        }
        dataStack.remove();

        // Shared-stack isolation: a rail mounted for one panel must disappear
        // when the next active panel has too few entries for a minimap. Otherwise
        // the user sees another conversation's ribs on the current session.
        const sharedStack = document.createElement("div");
        sharedStack.className = "session-messages-stack";
        const panelA = document.createElement("div");
        panelA.className = "session-messages is-active";
        panelA.style.cssText = "position:relative;height:300px;overflow:auto";
        const listA = document.createElement("div");
        listA.className = "messages";
        panelA.appendChild(listA);
        for (let i = 1; i <= 4; i += 1) {
          const a = document.createElement("article");
          a.className = "runtime-user-message";
          a.dataset.turnId = "isolation-a-" + i;
          const b = document.createElement("div");
          b.className = "runtime-user-body";
          b.textContent = "隔离A问题 " + i;
          a.appendChild(b);
          a.style.minHeight = "180px";
          listA.appendChild(a);
        }
        const panelB = document.createElement("div");
        panelB.className = "session-messages is-active";
        panelB.style.cssText = "position:relative;height:300px;overflow:auto";
        const listB = document.createElement("div");
        listB.className = "messages";
        panelB.appendChild(listB);
        const bOnly = document.createElement("article");
        bOnly.className = "runtime-user-message";
        const bBody = document.createElement("div");
        bBody.className = "runtime-user-body";
        bBody.textContent = "隔离B当前问题";
        bOnly.appendChild(bBody);
        listB.appendChild(bOnly);
        sharedStack.append(panelA, panelB);
        document.body.appendChild(sharedStack);
        updateMinimap(panelA, {
          items: [1, 2, 3, 4].map((i) => ({ role: "user", turnId: "isolation-a-" + i, label: "隔离A问题 " + i })),
        });
        const staleRail = sharedStack.querySelector(":scope > .conversation-minimap");
        if (!staleRail) throw new Error("setup should create a minimap rail for panel A");
        updateMinimap(panelB, {
          items: [{ role: "user", turnId: "isolation-b-1", label: "隔离B当前问题" }],
        });
        if (sharedStack.querySelector(":scope > .conversation-minimap")) {
          throw new Error("switching to a short conversation must remove the previous session's minimap rail");
        }
        sharedStack.remove();
        return "conversation-minimap-regression: ok";
      }
    )()`);
    console.log(minimapResult);
    const hoistedMediaResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const xml = '<generated_media type="video">\\n  <file path="/tmp/out/promo.mp4" bytes="1024" />\\n</generated_media>\\n';
        const tools = new Map();
        tools.set("t1", { id: "t1", name: "Bash", status: "done", result: { content: xml } });
        const liveTurn = {
          turnId: "turn_hoist_media", phase: "done", assistantText: "10秒视频生成成功",
          thinkingText: "", contentBlocks: [], processEvents: [], tools, timeline: [],
          notices: [], permissions: new Map(), questions: new Map(), hooks: new Map(),
          resultBlocks: [], artifacts: [], startedAt: Date.now(),
          final: { type: "turn.completed", payload: { assistant: "10秒视频生成成功" }, ts: Date.now() },
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_hoist", sealed: true });
        const hoisted = article.querySelector('[data-role="artifacts"] .assistant-hoisted-media');
        if (!hoisted) throw new Error("generated media should be hoisted to the prominent area");
        const video = hoisted.querySelector("video");
        if (!video) throw new Error("hoisted media should render a <video> player");
        if (!String(video.getAttribute("src") || "").startsWith("app-file://media/")) {
          throw new Error("hoisted media must use app-file:// scheme: " + video.getAttribute("src"));
        }
        // Re-render must not duplicate the hoisted block.
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_hoist", sealed: true });
        if (article.querySelectorAll('[data-role="artifacts"] .assistant-hoisted-media').length !== 1) {
          throw new Error("hoisted media must not duplicate on re-render");
        }
        return "hoisted-generated-media-regression: ok";
      }
    )()`);
    console.log(hoistedMediaResult);
    const hoistedMediaNarrativeCleanResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const xml = '<generated_media type="image">\\n  <file path="/tmp/out/photo.png" bytes="1024" />\\n</generated_media>';
        const tools = new Map();
        tools.set("t1", { id: "t1", name: "Bash", status: "done", result: { content: xml } });
        const liveTurn = {
          turnId: "turn_hoist_media_clean", phase: "done",
          assistantText: "Done.\\n\\n" + xml + "\\n\\nSaved.",
          thinkingText: "", contentBlocks: [], processEvents: [], tools, timeline: [],
          notices: [], permissions: new Map(), questions: new Map(), hooks: new Map(),
          resultBlocks: [], artifacts: [], startedAt: Date.now(),
          final: { type: "turn.completed", payload: { assistant: "Done.\\n\\n" + xml + "\\n\\nSaved." }, ts: Date.now() },
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_hoist_clean", sealed: true });
        if (!article.querySelector('[data-role="artifacts"] .assistant-hoisted-media img')) {
          throw new Error("generated media should still hoist after narrative cleanup");
        }
        const narrativeText = article.querySelector('[data-role="narrative"]')?.textContent || "";
        if (narrativeText.includes("<generated_media") || narrativeText.includes("</generated_media>")) {
          throw new Error("generated_media protocol marker leaked into narrative: " + narrativeText);
        }
        if (!narrativeText.includes("Done.") || !narrativeText.includes("Saved.")) {
          throw new Error("narrative cleanup should preserve surrounding prose: " + narrativeText);
        }
        return "hoisted-generated-media-narrative-clean-regression: ok";
      }
    )()`);
    console.log(hoistedMediaNarrativeCleanResult);
    const hoistedMediaGalleryResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const tools = new Map();
        for (let index = 1; index <= 5; index += 1) {
          const xml = '<generated_media type="image">\\n  <file path="/tmp/out/gallery-' + index + '.png" bytes="1024" />\\n</generated_media>';
          tools.set("t" + index, { id: "t" + index, name: "Bash", status: "done", result: { content: xml } });
        }
        tools.set("tv", {
          id: "tv",
          name: "Bash",
          status: "done",
          result: { content: '<generated_media type="video">\\n  <file path="/tmp/out/gallery-video.mp4" bytes="2048" />\\n</generated_media>' },
        });
        const liveTurn = {
          turnId: "turn_hoist_gallery", phase: "done", assistantText: "Gallery ready.",
          thinkingText: "", contentBlocks: [], processEvents: [], tools, timeline: [],
          notices: [], permissions: new Map(), questions: new Map(), hooks: new Map(),
          resultBlocks: [], artifacts: [], startedAt: Date.now(),
          final: { type: "turn.completed", payload: { assistant: "Gallery ready." }, ts: Date.now() },
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_hoist_gallery", sealed: true });
        const fileBlocks = article.querySelectorAll('[data-role="artifacts"] .assistant-hoisted-media .assistant-generated-media.is-file');
        if (fileBlocks.length !== 1) {
          throw new Error("generated results should aggregate into one file gallery block, got " + fileBlocks.length);
        }
        const images = fileBlocks[0].querySelectorAll("img");
        if (images.length !== 5) {
          throw new Error("generated image gallery should keep every image, got " + images.length);
        }
        if (fileBlocks[0].querySelectorAll("video").length !== 1) {
          throw new Error("generated file gallery should keep videos in the same grid");
        }
        const paths = [...fileBlocks[0].querySelectorAll("figcaption code")].map((node) => node.textContent);
        if (new Set(paths).size !== 6 || !paths.includes("/tmp/out/gallery-5.png") || !paths.includes("/tmp/out/gallery-video.mp4")) {
          throw new Error("generated file gallery should preserve paths: " + paths.join(","));
        }
        return "hoisted-generated-media-gallery-regression: ok";
      }
    )()`);
    console.log(hoistedMediaGalleryResult);
    const generatedMediaNarrativePreserveResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const xml = '<generated_media type="image">\\n  <file path="/tmp/out/example.png" bytes="1024" />\\n</generated_media>';
        const text = "Example marker:\\n\\n~~~xml\\n" + xml + "\\n~~~";
        const liveTurn = {
          turnId: "turn_media_marker_example", phase: "done",
          assistantText: text,
          thinkingText: "", contentBlocks: [], processEvents: [], tools: new Map(), timeline: [],
          notices: [], permissions: new Map(), questions: new Map(), hooks: new Map(),
          resultBlocks: [], artifacts: [], startedAt: Date.now(),
          final: { type: "turn.completed", payload: { assistant: text }, ts: Date.now() },
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_marker_example", sealed: true });
        const narrativeText = article.querySelector('[data-role="narrative"]')?.textContent || "";
        if (
          !(narrativeText.includes("<generated_media") || narrativeText.includes("&lt;generated_media")) ||
          !(narrativeText.includes("</generated_media>") || narrativeText.includes("&lt;/generated_media"))
        ) {
          throw new Error("generated_media text without hoisted tool media should be preserved: " + narrativeText);
        }
        if (article.querySelector('[data-role="artifacts"] .assistant-hoisted-media')) {
          throw new Error("narrative-only generated_media text should not create hoisted media");
        }
        return "generated-media-narrative-preserve-regression: ok";
      }
    )()`);
    console.log(generatedMediaNarrativePreserveResult);
    // Real-world regression: version-skewed generate-video.cjs printed only
    // "Done! … saved to: <path>" with NO <generated_media> marker. The video file
    // still lives under generated-assets/, so it must still hoist + preview. WHY:
    // previews cannot depend on a marker the deployed skill copy may not emit, or
    // the user loses the preview entirely (degrading below baseline file-chip UX).
    const markerlessMediaResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const p = "/Users/x/aicode/xiaoshuo/generated-assets/video-2026-06-27T20-13-49-148Z-a92cdf.mp4";
        const stdout = "\\n[4/4] Done! 7.8 MB saved to:\\n      " + p + "\\n\\n" + p + "\\n";
        const tools = new Map();
        tools.set("t1", { id: "t1", name: "Bash", status: "done", result: { content: stdout, truncated: false } });
        const liveTurn = {
          turnId: "turn_markerless", phase: "done", assistantText: "第三版生成完毕",
          thinkingText: "", contentBlocks: [], processEvents: [], tools, timeline: [],
          notices: [], permissions: new Map(), questions: new Map(), hooks: new Map(),
          resultBlocks: [], artifacts: [], startedAt: Date.now(),
          final: { type: "turn.completed", payload: { assistant: "第三版生成完毕" }, ts: Date.now() },
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_ml", sealed: true });
        const videos = article.querySelectorAll('[data-role="artifacts"] .assistant-hoisted-media video');
        if (videos.length !== 1) throw new Error("marker-less generated-assets video must hoist exactly once, got " + videos.length);
        if (!String(videos[0].getAttribute("src") || "").startsWith("app-file://media/")) {
          throw new Error("marker-less hoisted video must use app-file:// scheme: " + videos[0].getAttribute("src"));
        }
        // A referenced/read image OUTSIDE generated-assets must NOT hoist.
        const tools2 = new Map();
        tools2.set("t2", { id: "t2", name: "Read", status: "done", result: { content: "see /Users/x/project/assets/logo.png for the brand mark" } });
        const lt2 = { ...liveTurn, turnId: "turn_ref", tools: tools2 };
        const art2 = createLiveTurnArticleShell(lt2);
        renderLiveTurnArticle(art2, lt2, { sessionId: "s_ref", sealed: true });
        if (art2.querySelector('[data-role="artifacts"] .assistant-hoisted-media')) {
          throw new Error("referenced image outside generated-assets must NOT be hoisted");
        }
        return "markerless-generated-assets-media-regression: ok";
      }
    )()`);
    console.log(markerlessMediaResult);
    const narrativeUpgradeResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const liveTurn = {
          turnId: "turn_md_upgrade",
          phase: "responding",
          assistantText: "渲染一致性测试正文",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [],
          notices: [],
          permissions: new Map(),
          questions: new Map(),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_md_upgrade" });
        const liveEl = article.querySelector(".assistant-turn-narrative-text");
        if (!liveEl || liveEl.dataset.renderMode !== "stream") {
          throw new Error("live narrative should use the streaming render, got " + (liveEl && liveEl.dataset.renderMode));
        }
        // Seal the SAME turn (same DOM element reused) with unchanged text — must
        // upgrade to the full render so live output matches the reloaded history.
        liveTurn.phase = "done";
        liveTurn.final = { type: "turn.completed", payload: { assistant: liveTurn.assistantText }, ts: Date.now() };
        liveTurn.finalRendered = false;
        renderLiveTurnArticle(article, liveTurn, { sessionId: "s_md_upgrade", sealed: true });
        const sealedEl = article.querySelector(".assistant-turn-narrative-text");
        if (!sealedEl || sealedEl.dataset.renderMode !== "full") {
          throw new Error("sealing must upgrade narrative to the full render, got " + (sealedEl && sealedEl.dataset.renderMode));
        }
        return "narrative-markdown-upgrade-regression: ok";
      }
    )()`);
    console.log(narrativeUpgradeResult);
    const liveTurnPreserveResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages, applyRuntimeEvent } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_live_preserve_regression";
        store.set("activeSessionId", sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", content: "第一条历史消息", timestamp: "2026-01-01T00:00:00.000Z" },
        ]);
        showSessionMessages(sessionId);
        renderConversation(sessionId, { force: true });
        applyRuntimeEvent({
          sessionId,
          type: "turn.started",
          turnId: "turn_live_preserve_regression",
          ts: Date.now(),
          payload: { text: "正在跑的任务" },
        });
        renderConversation(sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", content: "第一条历史消息", timestamp: "2026-01-01T00:00:00.000Z" },
          { role: "user", content: "切回来后补进来的历史消息", timestamp: "2026-01-01T00:00:01.000Z" },
        ]);
        renderConversation(sessionId);
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        const children = Array.from(panel?.children || []);
        const liveIndex = children.findIndex((el) => el.classList.contains("assistant-turn-article"));
        const lateIndex = children.findIndex((el) => el.textContent.includes("切回来后补进来的历史消息"));
        if (liveIndex < 0) throw new Error("live turn article was not preserved");
        if (lateIndex < 0) throw new Error("late committed message was not rendered");
        if (lateIndex > liveIndex) {
          throw new Error("late committed message rendered after live turn");
        }
        return "live-turn-preserve-regression: ok";
      }
    )()`);
    console.log(liveTurnPreserveResult);
    const initialConversationResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation, shouldPreserveSessionView } = await import("./modules/message.js");
        const sessionId = "session_initial_conversation_regression";
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        if (shouldPreserveSessionView(sessionId)) {
          throw new Error("empty session placeholder should not preserve the session view");
        }
        syncCommittedMessages(sessionId, [
          { role: "user", content: "默认会话首次加载的消息", timestamp: "2026-01-01T00:00:00.000Z" },
        ]);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        if (!panel?.textContent.includes("默认会话首次加载的消息")) {
          throw new Error("initial conversation was not rendered");
        }
        return "initial-conversation-regression: ok";
      }
    )()`);
    console.log(initialConversationResult);
    const sameTurnCommittedResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_same_turn_committed_regression";
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", turnId: "turn_same_key", content: "同一轮用户问题", timestamp: "2026-01-01T00:00:00.000Z" },
          { role: "assistant", turnId: "turn_same_key", content: "同一轮助手回答", timestamp: "2026-01-01T00:00:01.000Z" },
        ]);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        const text = panel?.textContent || "";
        if (!text.includes("同一轮用户问题") || !text.includes("同一轮助手回答")) {
          throw new Error("same-turn committed user and assistant messages must both render");
        }
        return "same-turn-committed-regression: ok";
      }
    )()`);
    console.log(sameTurnCommittedResult);
    const chronologicalCommittedRenderResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_chronological_committed_render_regression";
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", turnId: "turn_newest", content: "最新消息不应在最上面", timestamp: "2026-01-01T00:00:03.000Z" },
          { role: "assistant", turnId: "turn_middle", content: "中间回答", timestamp: "2026-01-01T00:00:02.000Z" },
          { role: "user", turnId: "turn_middle", content: "中间问题", timestamp: "2026-01-01T00:00:01.000Z" },
          { role: "user", turnId: "turn_oldest", content: "第一条消息必须在最上面", timestamp: "2026-01-01T00:00:00.000Z" },
        ]);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        const text = panel?.textContent || "";
        const oldest = text.indexOf("第一条消息必须在最上面");
        const middleQuestion = text.indexOf("中间问题");
        const middleAnswer = text.indexOf("中间回答");
        const newest = text.indexOf("最新消息不应在最上面");
        if (!(oldest >= 0 && middleQuestion > oldest && middleAnswer > middleQuestion && newest > middleAnswer)) {
          throw new Error("committed history must render chronological even if source array is reversed: " + JSON.stringify({
            oldest,
            middleQuestion,
            middleAnswer,
            newest,
            text,
          }));
        }
        return "chronological-committed-render-regression: ok";
      }
    )()`);
    console.log(chronologicalCommittedRenderResult);
    const nextUserAfterCompletedLiveResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { applyRuntimeEvent } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_next_user_after_completed_live_regression";
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        applyRuntimeEvent({
          sessionId,
          type: "user.committed",
          turnId: "turn_old_completed_live",
          seq: 1,
          ts: 1000,
          payload: { text: "旧问题" },
        });
        applyRuntimeEvent({
          sessionId,
          type: "turn.started",
          turnId: "turn_old_completed_live",
          seq: 2,
          ts: 1001,
          payload: { text: "旧问题" },
        });
        applyRuntimeEvent({
          sessionId,
          type: "assistant.delta",
          turnId: "turn_old_completed_live",
          seq: 3,
          ts: 1002,
          payload: { text: "旧回答" },
        });
        applyRuntimeEvent({
          sessionId,
          type: "turn.completed",
          turnId: "turn_old_completed_live",
          seq: 4,
          ts: 1003,
          payload: { assistant: "旧回答" },
        });
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        await frame();
        await frame();

        // This is the preflight gap that previously caused disorder: the next
        // user message is committed before the new live turn has started.
        applyRuntimeEvent({
          sessionId,
          type: "user.committed",
          turnId: "turn_new_preflight_gap",
          seq: 5,
          ts: 1004,
          payload: { text: "新问题不能插到旧回答前" },
        });
        renderConversation(sessionId);
        await frame();
        await frame();

        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        const text = panel?.textContent || "";
        const oldQuestion = text.indexOf("旧问题");
        const oldAnswer = text.indexOf("旧回答");
        const newQuestion = text.indexOf("新问题不能插到旧回答前");
        if (!(oldQuestion >= 0 && oldAnswer > oldQuestion && newQuestion > oldAnswer)) {
          throw new Error("new committed user message must render after the completed assistant answer: " + JSON.stringify({
            oldQuestion,
            oldAnswer,
            newQuestion,
            text,
          }));
        }
        return "next-user-after-completed-live-regression: ok";
      }
    )()`);
    console.log(nextUserAfterCompletedLiveResult);
    const fastSessionSwitchResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { applySessionSwitch } = await import("./modules/session-chrome.js");
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        store.set("projects", [{
          id: "p_switch_perf",
          sessions: [
            { id: "session_switch_slow_a", title: "Slow A" },
            { id: "session_switch_fast_b", title: "Fast B" },
          ],
        }]);
        store.set("activeProjectId", "p_switch_perf");
        const slowPromise = applySessionSwitch({ ok: true }, "session_switch_slow_a", "p_switch_perf");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const slowPanel = document.querySelector('.session-messages[data-session-id="session_switch_slow_a"]');
        if (!slowPanel?.classList.contains("is-active")) {
          throw new Error("session switch should reveal the target panel before conversation load resolves");
        }
        await applySessionSwitch({ ok: true }, "session_switch_fast_b", "p_switch_perf");
        for (let i = 0; i < 80; i++) {
          const text = (store.get("conversation") || []).map((m) => m.content).join("\\n");
          if (text.includes("fast B wins")) break;
          await delay(10);
        }
        await slowPromise;
        await delay(140);
        const active = document.querySelector(".session-messages.is-active");
        if (active?.dataset.sessionId !== "session_switch_fast_b") {
          throw new Error("late slow-session load must not steal active panel");
        }
        const conversationText = (store.get("conversation") || []).map((m) => m.content).join("\\n");
        if (!conversationText.includes("fast B wins") || conversationText.includes("slow A should not win")) {
          throw new Error("late slow-session load must not overwrite active conversation store: " + conversationText);
        }
        return "fast-session-switch-regression: ok";
      }
    )()`);
    console.log(fastSessionSwitchResult);
    const largeConversationWindowResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_large_history_window_regression";
        const messages = Array.from({ length: 240 }, (_, index) => ({
          id: "msg_large_" + index,
          role: index % 2 === 0 ? "user" : "assistant",
          content: "large history message " + index,
          timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
        }));
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        syncCommittedMessages(sessionId, messages);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        // Poll instead of a fixed sleep: committed history paints in chunks, so
        // the latest message lands last — a fixed wait is flaky on slow CI runners.
        const sel = \`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`;
        let panel = document.querySelector(sel);
        for (let i = 0; i < 200 && !(panel?.textContent || "").includes("large history message 239"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          panel = document.querySelector(sel);
        }
        const count = panel?.children?.length || 0;
        const text = panel?.textContent || "";
        if (count > 90) {
          throw new Error("large history switch should mount a bounded recent window, got " + count);
        }
        if (!text.includes("large history message 239")) {
          throw new Error("large history window should keep the latest message: " + JSON.stringify({
            count,
            start: text.slice(0, 160),
            end: text.slice(-160),
          }));
        }
        if (text.includes("large history message 0")) {
          throw new Error("large history window should not mount the oldest message on first paint");
        }
        return "large-history-window-regression: ok";
      }
    )()`);
    console.log(largeConversationWindowResult);
    const largeConversationPreserveScrollResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { renderConversation } = await import("./modules/message.js");
        const sessionId = "session_large_history_window_regression";
        renderConversation(sessionId, { force: true, preserveScroll: true });
        // Poll until the full history range has painted (flaky as a fixed sleep
        // on CI): wait for both the oldest and newest message text to be present.
        const sel = \`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`;
        let panel = document.querySelector(sel);
        const ready = () => {
          const t = panel?.textContent || "";
          return t.includes("large history message 0") && t.includes("large history message 239");
        };
        for (let i = 0; i < 200 && !ready(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          panel = document.querySelector(sel);
        }
        const text = panel?.textContent || "";
        const count = panel?.children?.length || 0;
        if (!text.includes("large history message 0") || !text.includes("large history message 239")) {
          throw new Error("preserve-scroll rerender should keep the loaded history range");
        }
        if (count < 220) {
          throw new Error("preserve-scroll rerender should mount the loaded older page, got " + count);
        }
        return "large-history-preserve-scroll-regression: ok";
      }
    )()`);
    console.log(largeConversationPreserveScrollResult);
    const liveScrollFollowLockResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { isUserScrollDetached, scrollToBottom } = await import("./modules/dom.js");
        const { syncCommittedMessages, applyRuntimeEvent } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_live_scroll_follow_lock_regression";
        const messages = Array.from({ length: 34 }, (_, index) => ({
          id: "msg_scroll_lock_" + index,
          role: index % 2 === 0 ? "user" : "assistant",
          content: "scroll follow lock message " + index + "\\n" + "content line ".repeat(40),
          timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
        }));
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        syncCommittedMessages(sessionId, messages);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"]\`);
        const ready = () => panel && panel.scrollHeight > panel.clientHeight + 500 && (panel.textContent || "").includes("scroll follow lock message 33");
        for (let i = 0; i < 200 && !ready(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (!ready()) {
          throw new Error("scroll lock fixture did not become scrollable");
        }
        scrollToBottom(true, panel);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bottomTop = panel.scrollTop;
        const nearBottomTop = Math.max(0, bottomTop - 36);
        panel.dispatchEvent(new WheelEvent("wheel", { deltaY: -36, bubbles: true }));
        panel.scrollTop = nearBottomTop;
        panel.dispatchEvent(new Event("scroll"));
        if (!isUserScrollDetached(panel)) {
          throw new Error("upward user scroll near bottom must detach live auto-follow: " + JSON.stringify({
            bottomTop,
            nearBottomTop,
            actualTop: panel.scrollTop,
            lastScrollTop: panel.dataset.lastScrollTop,
            programmatic: panel.dataset.programmaticScroll || "",
            scrollHeight: panel.scrollHeight,
            clientHeight: panel.clientHeight,
          }));
        }
        applyRuntimeEvent({
          sessionId,
          type: "turn.started",
          turnId: "turn_live_scroll_follow_lock_regression",
          ts: Date.now(),
          payload: { text: "running" },
        });
        applyRuntimeEvent({
          sessionId,
          type: "assistant.delta",
          turnId: "turn_live_scroll_follow_lock_regression",
          ts: Date.now() + 1,
          payload: { text: "streamed text while user is reading" },
        });
        renderConversation(sessionId);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (panel.scrollTop > nearBottomTop + 8) {
          throw new Error(\`live render pulled user back to latest: before=\${nearBottomTop} after=\${panel.scrollTop}\`);
        }
        scrollToBottom(true, panel);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (isUserScrollDetached(panel)) {
          throw new Error("clicking Latest/force bottom should re-enable live auto-follow");
        }
        applyRuntimeEvent({
          sessionId,
          type: "assistant.delta",
          turnId: "turn_live_scroll_follow_lock_regression",
          ts: Date.now() + 2,
          payload: { text: "\\nmore streamed text" },
        });
        renderConversation(sessionId);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const maxTop = panel.scrollHeight - panel.clientHeight;
        if (panel.scrollTop < maxTop - 80) {
          throw new Error(\`auto-follow did not resume after Latest: top=\${panel.scrollTop} max=\${maxTop}\`);
        }
        return "live-scroll-follow-lock-regression: ok";
      }
    )()`);
    console.log(liveScrollFollowLockResult);
    const multiSelectQuestionResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const liveTurn = {
          turnId: "turn_multiselect_question_regression",
          phase: "tool_running",
          assistantText: "",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [],
          notices: [],
          permissions: new Map(),
          questions: new Map([
            ["req_question_multi", {
              requestId: "req_question_multi",
              questions: [{
                id: "mode",
                question: "Pick modes",
                multiSelect: true,
                options: [{ label: "Fast" }, { label: "Careful" }],
              }],
            }],
          ]),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        document.body.appendChild(article);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "session_multiselect_question_regression" });
        const optionButtons = Array.from(article.querySelectorAll(".assistant-question-option"));
        if (optionButtons.length !== 2) throw new Error("multi-select options did not render");
        optionButtons[0].click();
        optionButtons[1].click();
        renderLiveTurnArticle(article, liveTurn, { sessionId: "session_multiselect_question_regression" });
        const selectedAfterRerender = Array.from(article.querySelectorAll(".assistant-question-option.is-selected"))
          .map((btn) => btn.textContent)
          .join(",");
        if (selectedAfterRerender !== "Fast,Careful") {
          throw new Error("question selections should survive live turn rerender: " + selectedAfterRerender);
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        const submit = article.querySelector(".assistant-prompt-actions .assistant-action-btn");
        if (!submit) throw new Error("multi-select question should render an explicit submit action");
        submit.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        article.remove();
        return "multi-select-question-regression: ok";
      }
    )()`);
    console.log(multiSelectQuestionResult);
    const sealedTurnLayoutResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_sealed_layout_regression",
          terminal: "turn.completed",
          assistantText: "先说过程。\\n\\n最终答案。",
          startedAt: 1000,
          endedAt: 5000,
          timeline: [
            { kind: "text", id: "text_1", ts: 1000, text: "先说过程。", status: "done" },
            { kind: "thinking", id: "think_1", startTs: 1100, ts: 2100, text: "分析中", status: "done" },
            { kind: "tool", id: "read_1", ts: 2200, name: "Read", input: { file_path: "a.md" }, status: "done" },
            { kind: "text", id: "text_2", ts: 3000, text: "最终答案。", status: "done" },
          ],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const process = article.querySelector("[data-role='process']");
        const narrative = article.querySelector("[data-role='narrative']");
        if (!process || !narrative) throw new Error("sealed article missing core regions");
        const order = process.compareDocumentPosition(narrative);
        article.remove();
        if (!(order & Node.DOCUMENT_POSITION_FOLLOWING)) {
          throw new Error("sealed process details must render before the answer after reload");
        }
        return "sealed-turn-layout-regression: ok";
      }
    )()`);
    console.log(sealedTurnLayoutResult);
    const sealedTurnArtifactResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_artifact_slot_regression",
          terminal: "turn.completed",
          assistantText: "图片如下：output/chart.svg",
          startedAt: 1000,
          endedAt: 3000,
          // The generated image streams inline into the answer (content-block image).
          contentBlocks: [{
            blockType: "image",
            mediaType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          }],
          // …and is ALSO recorded as a turn artifact. Inline-only image rendering
          // (feat: bab421d) must NOT re-card it as a separate deliverables card.
          artifacts: [{
            id: "artifact_chart",
            kind: "image",
            path: "/tmp/lily-renderer-artifact.svg",
            relativePath: "output/chart.svg",
            fileName: "chart.svg",
            ext: ".svg",
            mimeType: "image/svg+xml",
            bytes: 128,
            updatedAt: 1000,
          }],
          timeline: [{ kind: "text", id: "text_1", ts: 2000, text: "图片如下：output/chart.svg", status: "done" }],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const inlineImgs = article.querySelectorAll("[data-role='narrative'] img.assistant-content-image");
        const artifactSlot = article.querySelector("[data-role='artifacts']");
        const slotImgs = artifactSlot ? artifactSlot.querySelectorAll(".assistant-renderer-artifact img") : [];
        const html = article.innerHTML;
        article.remove();
        if (inlineImgs.length !== 1) {
          throw new Error("generated image should render inline in the answer: " + html);
        }
        if (slotImgs.length !== 0) {
          throw new Error("inline image must not be re-carded in the artifacts slot: " + html);
        }
        return "sealed-turn-artifact-slot-regression: ok";
      }
    )()`);
    console.log(sealedTurnArtifactResult);
    const artifactOnlyImageResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_artifact_only_image_regression",
          terminal: "turn.completed",
          assistantText: "SVG 文件：output/location-pie-chart.svg",
          startedAt: 1000,
          endedAt: 3000,
          resultBlocks: [{
            id: "artifact_svg_only",
            type: "artifact",
            artifactType: "image",
            path: "/tmp/lily-renderer-artifact-only.svg",
            relativePath: "output/location-pie-chart.svg",
            fileName: "location-pie-chart.svg",
            ext: ".svg",
            mimeType: "image/svg+xml",
            bytes: 128,
            updatedAt: 1000,
          }],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const artifactSlot = article.querySelector("[data-role='artifacts']");
        const slotImgs = artifactSlot ? artifactSlot.querySelectorAll(".assistant-renderer-artifact img") : [];
        const reveal = artifactSlot ? artifactSlot.querySelector(".assistant-reveal-btn") : null;
        const html = article.innerHTML;
        article.remove();
        if (slotImgs.length !== 1) {
          throw new Error("artifact-only image should render a preview card: " + html);
        }
        if (!reveal || reveal.disabled) {
          throw new Error("artifact-only image card should keep a reveal action: " + html);
        }
        return "artifact-only-image-preview-regression: ok";
      }
    )()`);
    console.log(artifactOnlyImageResult);
    const fileMentionPreviewPathResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_file_mention_preview_path_regression",
          terminal: "turn.completed",
          assistantText: "SVG 文件：\`output/location-pie-chart.svg\`",
          startedAt: 1000,
          endedAt: 3000,
          resultBlocks: [{
            id: "artifact_svg_mention",
            type: "artifact",
            artifactType: "image",
            path: "/tmp/lily-renderer-file-mention.svg",
            relativePath: "output/location-pie-chart.svg",
            fileName: "location-pie-chart.svg",
            ext: ".svg",
            mimeType: "image/svg+xml",
            bytes: 128,
            updatedAt: 1000,
          }],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const button = article.querySelector(".file-mention-action");
        const html = article.innerHTML;
        if (!button) throw new Error("relative file mention with artifact mapping should render a preview action: " + html);
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        article.remove();
        return "file-mention-preview-path-regression: ok";
      }
    )()`);
    console.log(fileMentionPreviewPathResult);
    if (!capturedOpenPaths.includes(":/tmp/lily-renderer-file-mention.svg")) {
      throw new Error("file mention preview should open the artifact absolute path, got: " + JSON.stringify(capturedOpenPaths));
    }
    const multiRendererResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { renderResultBlocks } = await import("./modules/turn-block-renderers.js");
        const host = document.createElement("div");
        document.body.appendChild(host);
        const tinyPdfBase64 = ${JSON.stringify(tinyPdfBase64)};
        renderResultBlocks(host, [
          { id: "md", type: "markdown", text: "**正文**" },
          { id: "table", type: "table", columns: ["name", "count"], rows: [{ name: "Dubai", count: 2 }] },
          { id: "form", type: "form", title: "确认信息", fields: [{ label: "城市", value: "Dubai" }] },
          { id: "code", type: "code", language: "js", code: "console.log('ok')" },
          { id: "pdf", type: "pdf", title: "Tiny PDF", data: tinyPdfBase64, mimeType: "application/pdf" },
          { id: "html", type: "html", title: "Tiny HTML", html: "<h1>HTML Report</h1><p>ok</p>" },
          { id: "md-report", type: "artifact", artifactType: "markdown", path: "/tmp/report.md", relativePath: "output/report.md", mimeType: "text/markdown" },
          {
            id: "html-reference",
            type: "artifact",
            artifactType: "html",
            path: "/tmp/referenced-only.html",
            relativePath: "docs/referenced-only.html",
            mimeType: "text/html",
            source: "tool_output",
          },
          {
            id: "pdf-reference",
            type: "artifact",
            artifactType: "pdf",
            path: "/tmp/referenced-only.pdf",
            relativePath: "docs/referenced-only.pdf",
            mimeType: "application/pdf",
            source: "assistant_text",
          },
          {
            id: "image-reference",
            type: "artifact",
            artifactType: "image",
            path: "/tmp/referenced-only.svg",
            relativePath: "docs/referenced-only.svg",
            mimeType: "image/svg+xml",
            source: "tool_output",
          },
          {
            id: "video-artifact",
            type: "artifact",
            artifactType: "video",
            path: "/tmp/generated-assets/promo.mp4",
            relativePath: "generated-assets/promo.mp4",
            mimeType: "video/mp4",
            bytes: 2048,
            source: "file_change",
          },
          {
            id: "audio-artifact",
            type: "artifact",
            artifactType: "audio",
            path: "/tmp/generated-assets/voice.wav",
            relativePath: "generated-assets/voice.wav",
            mimeType: "audio/wav",
            bytes: 1024,
            source: "file_change",
          },
          {
            id: "md-mention-only",
            type: "artifact",
            artifactType: "markdown",
            path: "/tmp/referenced-only.md",
            relativePath: "docs/referenced-only.md",
            mimeType: "text/markdown",
            source: "assistant_text",
          },
          {
            id: "echarts",
            type: "chart",
            chartType: "pie",
            title: "Cities",
            columns: ["city", "count"],
            rows: [{ city: "Dubai", count: 2 }, { city: "Abu Dhabi", count: 1 }],
          },
          { id: "chart", type: "chart", chartType: "mermaid", source: "pie showData\\n  title Cities\\n  \\"Dubai\\" : 2" },
          { id: "legacy-chart", type: "artifact", artifactType: "chart", chartType: "mermaid", source: "graph TD\\n  A-->B" },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (!host.querySelector(".assistant-renderer-markdown strong")) {
          throw new Error("markdown result block did not render rich markdown");
        }
        if (!host.querySelector(".assistant-renderer-table")) {
          throw new Error("table result block did not render a table container");
        }
        if (!host.querySelector(".assistant-data-table-grid.tabulator, .assistant-data-table-grid .tabulator")) {
          throw new Error("table result block should render through Tabulator");
        }
        if (!host.textContent.includes("Dubai")) {
          throw new Error("table result block did not preserve row content");
        }
        if (!host.querySelector(".assistant-renderer-form-row")) {
          throw new Error("form result block did not render fields");
        }
        if (!host.querySelector(".assistant-renderer-code code")) {
          throw new Error("code result block did not render code");
        }
        if (!host.querySelector(".assistant-renderer-pdf canvas")) {
          throw new Error("pdf result block did not render a PDF canvas");
        }
        if (!host.querySelector(".assistant-renderer-pdf .assistant-pdf-pages")) {
          throw new Error("pdf result block should render as a continuous page stack");
        }
        if (!host.textContent.includes("Fit") && !host.textContent.includes("适宽")) {
          throw new Error("pdf result block should expose fit-width controls");
        }
        const pdfViewerButton = host.querySelector(".assistant-pdf-open-viewer");
        if (!pdfViewerButton) {
          throw new Error("pdf result block should expose the in-app reader action");
        }
        pdfViewerButton.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const pdfViewer = document.querySelector(".pdf-viewer");
        if (!pdfViewer || !pdfViewer.querySelector(".pdf-viewer-scroll") || !pdfViewer.querySelector(".pdf-viewer-thumbs")) {
          throw new Error("pdf reader action should open the in-app PDF viewer");
        }
        pdfViewer.querySelector(".pdf-viewer-close")?.click();
        if (!host.querySelector(".assistant-renderer-html iframe")) {
          throw new Error("html result block did not render a sandboxed iframe");
        }
        const videoArtifact = host.querySelector(".assistant-renderer-artifact.is-video video");
        if (!videoArtifact || !String(videoArtifact.getAttribute("src") || "").startsWith("app-file://media/")) {
          throw new Error("video artifact should render a playable app-file video: " + host.innerHTML);
        }
        const audioArtifact = host.querySelector(".assistant-renderer-artifact.is-audio audio");
        if (!audioArtifact || !String(audioArtifact.getAttribute("src") || "").startsWith("app-file://media/")) {
          throw new Error("audio artifact should render a playable app-file audio: " + host.innerHTML);
        }
        if (host.querySelectorAll(".assistant-renderer-artifact.is-video .assistant-reveal-btn").length !== 1) {
          throw new Error("video artifact should keep a reveal action: " + host.innerHTML);
        }
        const markdownArtifact = host.querySelector(".assistant-renderer-markdown-artifact");
        if (!markdownArtifact || !markdownArtifact.textContent.includes("output/report.md")) {
          throw new Error("markdown artifact should render a top-level preview card with its file path");
        }
        if (!markdownArtifact.querySelector(".assistant-reveal-btn")) {
          throw new Error("markdown artifact should keep a reveal action");
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (markdownArtifact.querySelector(".assistant-renderer-markdown-details")) {
          throw new Error("markdown artifact preview should be top-level, not hidden in collapsible details");
        }
        if (!markdownArtifact.querySelector(".assistant-renderer-markdown-preview h1") || !markdownArtifact.textContent.includes("Markdown Report")) {
          throw new Error("markdown artifact should auto-load a top-level markdown preview");
        }
        const markdownPreview = markdownArtifact.querySelector(".assistant-renderer-markdown-preview");
        if (!markdownPreview.classList.contains("assistant-turn-final")) {
          throw new Error("markdown artifact preview should use the same rich reading style as final answers");
        }
        if (!markdownPreview.querySelector("table") || !markdownPreview.querySelector("code") || !markdownPreview.querySelector("hr")) {
          throw new Error("markdown artifact preview should render rich markdown structures");
        }
        const relativeMarkdownImage = markdownPreview.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/report-assets.png']");
        if (!relativeMarkdownImage) {
          throw new Error("markdown artifact relative images should resolve against the markdown file path: " + markdownPreview.innerHTML);
        }
        if (!String(relativeMarkdownImage.getAttribute("src") || "").startsWith("app-file://media/")) {
          throw new Error("markdown artifact relative images should render via app-file:// media: " + relativeMarkdownImage.getAttribute("src"));
        }
        const markdownPreviewStyle = getComputedStyle(markdownArtifact.querySelector(".assistant-renderer-markdown-preview"));
        if (markdownPreviewStyle.overflowY !== "visible" || markdownPreviewStyle.maxHeight !== "none") {
          throw new Error("markdown artifact preview should flow with the card instead of using an inner scroller");
        }
        if (markdownPreviewStyle.borderTopWidth !== "0px") {
          throw new Error("markdown artifact preview should not have a nested preview border");
        }
        const mentionOnly = Array.from(host.querySelectorAll(".assistant-renderer-artifact.is-file"))
          .find((node) => node.textContent.includes("docs/referenced-only.md"));
        if (!mentionOnly) {
          throw new Error("assistant-text-only markdown references should render as compact file artifacts");
        }
        if (Array.from(host.querySelectorAll(".assistant-renderer-markdown-artifact"))
          .some((node) => node.textContent.includes("docs/referenced-only.md"))) {
          throw new Error("assistant-text-only markdown references should not auto-expand into previews");
        }
        for (const referencedPath of ["docs/referenced-only.html", "docs/referenced-only.pdf", "docs/referenced-only.svg"]) {
          const compact = Array.from(host.querySelectorAll(".assistant-renderer-artifact.is-compact"))
            .find((node) => node.textContent.includes(referencedPath));
          if (!compact) throw new Error("referenced preview artifact should render compact: " + referencedPath);
        }
        if (Array.from(host.querySelectorAll(".assistant-renderer-html"))
          .some((node) => node.textContent.includes("docs/referenced-only.html"))) {
          throw new Error("referenced html should not render an iframe preview");
        }
        if (Array.from(host.querySelectorAll(".assistant-renderer-pdf"))
          .some((node) => node.textContent.includes("docs/referenced-only.pdf"))) {
          throw new Error("referenced pdf should not render a PDF preview");
        }
        const compactImage = Array.from(host.querySelectorAll(".assistant-renderer-artifact.is-compact"))
          .find((node) => node.textContent.includes("docs/referenced-only.svg"));
        if (compactImage?.querySelector("img")) {
          throw new Error("referenced image should not render an image preview");
        }
        if (!host.querySelector(".assistant-renderer-echarts canvas")) {
          throw new Error("structured chart result block should render through ECharts");
        }
        const mermaidCount = host.querySelectorAll(".markdown-mermaid-source code.language-mermaid, .markdown-mermaid").length;
        if (mermaidCount !== 2) {
          throw new Error("chart result block should route mermaid through markdown renderer");
        }
        renderResultBlocks(host, []);
        if (!host.hidden || host.querySelector("canvas") || host.querySelector("iframe")) {
          throw new Error("result block rerender should clear and dispose previous chart DOM");
        }
        host.remove();
        return "multi-renderer-result-blocks-regression: ok";
      }
    )()`);
    console.log(multiRendererResult);
    const contentImagePromotionResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lGj0GQAAAABJRU5ErkJggg==";
        const turn = liveTurnFromRecord({
          turnId: "turn_content_image_promotion",
          terminal: "turn.completed",
          assistantText: "图片已生成。",
          startedAt: 1000,
          endedAt: 3000,
          contentBlocks: [{ blockType: "image", mediaType: "image/png", data: tinyPng }],
          resultBlocks: [{
            id: "content:image:0",
            type: "artifact",
            artifactType: "image",
            data: tinyPng,
            mimeType: "image/png",
            alt: "Generated image",
            source: "content_block",
          }],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const narrativeImages = article.querySelectorAll("[data-role='narrative'] .assistant-content-image");
        const artifactImages = article.querySelectorAll("[data-role='artifacts'] .assistant-renderer-artifact img");
        // Inline-only image rendering (feat: bab421d): a content-block image renders
        // once in the answer and is NOT also promoted to a deliverables-slot card.
        if (narrativeImages.length !== 1 || artifactImages.length !== 0) {
          throw new Error("content image should render inline exactly once, not promoted to the slot: " + article.innerHTML);
        }
        article.remove();
        return "content-image-inline-regression: ok";
      }
    )()`);
    console.log(contentImagePromotionResult);
    const thinkingStackResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_thinking_stack_regression",
          terminal: "turn.completed",
          assistantText: "完成。",
          startedAt: 1000,
          endedAt: 9000,
          timeline: [
            { kind: "thinking", id: "think_1", startTs: 1000, ts: 2000, text: "第一段思考", status: "done" },
            { kind: "thinking", id: "think_2", startTs: 2100, ts: 5100, text: "第二段思考", status: "done" },
            { kind: "thinking", id: "think_3", startTs: 5200, ts: 8200, text: "第三段思考", status: "done" },
            { kind: "text", id: "text_1", ts: 8300, text: "完成。", status: "done" },
          ],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const process = article.querySelector("[data-role='process']");
        const stack = process?.querySelector(".assistant-process-thinking-stack");
        if (!stack) throw new Error("sealed multi-thinking turn should render one thinking stack");
        if (stack.open) throw new Error("sealed thinking stack should be collapsed by default");
        const topThinkingRows = Array.from(process.querySelector(".assistant-turn-timeline")?.children || [])
          .filter((el) => el.classList.contains("assistant-process-thinking-group"));
        article.remove();
        if (topThinkingRows.length !== 1 || topThinkingRows[0] !== stack) {
          throw new Error("sealed thinking entries should not flood the top-level process timeline");
        }
        return "thinking-stack-regression: ok";
      }
    )()`);
    console.log(thinkingStackResult);
    const sealedProcessTextMermaidResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_sealed_process_text_mermaid_regression",
          terminal: "turn.completed",
          assistantText: "最终说明。",
          startedAt: 1000,
          endedAt: 5000,
          timeline: [
            {
              kind: "text",
              id: "text_1",
              ts: 2000,
              status: "done",
              text: [
                "SVG 文件已在浏览器中打开。另外用 Mermaid 在聊天里直接渲染：",
                "",
                "    pie showData",
                "        title 事件发生地点分布",
                "        \\\"Abu Dhabi\\\" : 8",
              ].join("\\n"),
            },
            { kind: "text", id: "text_2", ts: 3000, status: "done", text: "最终说明。" },
          ],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const process = article.querySelector("[data-role='process']");
        if (!process?.querySelector(".markdown-mermaid-source code.language-mermaid")) {
          throw new Error("sealed process text mermaid should render through the full markdown content path: " + (process?.innerHTML || ""));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!process?.querySelector(".markdown-mermaid svg")) {
          throw new Error("sealed process text mermaid should render to SVG: " + (process?.innerHTML || ""));
        }
        if (process.innerHTML.includes("<code>pie showData")) {
          throw new Error("sealed process text mermaid should not remain a raw indented code block: " + process.innerHTML);
        }
        article.remove();
        return "sealed-process-text-mermaid-regression: ok";
      }
    )()`);
    console.log(sealedProcessTextMermaidResult);
    const markdownRichResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { renderMarkdown, renderMarkdownWithCache } = await import("./modules/markdown.js");
        const fence = String.fromCharCode(96).repeat(3);
        const host = document.createElement("div");
        host.className = "markdown-body";
        document.body.appendChild(host);
        renderMarkdownWithCache(host, [
          fence + "js",
          "console.log('copy me')",
          fence,
          "- [x] 已完成",
        ].join("\\n"));
        if (!host.querySelector(".markdown-code-copy")) {
          throw new Error("code blocks should render a copy action");
        }
        if (!host.querySelector(".markdown-task-list-item")) {
          throw new Error("task list items should receive rich markdown styling");
        }
        const pathShell = document.createElement("div");
        pathShell.dataset.sessionId = "session_markdown_reveal";
        document.body.appendChild(pathShell);
        const pathHost = document.createElement("div");
        pathHost.className = "markdown-body";
        pathShell.appendChild(pathHost);
        renderMarkdownWithCache(pathHost, "已生成文件：/tmp/lily-output/generated image.png");
        const localPathLink = pathHost.querySelector(".markdown-local-file-link[data-local-file-path]");
        if (!localPathLink || localPathLink.dataset.localFilePath !== "/tmp/lily-output/generated image.png") {
          throw new Error("plain local file paths should become reveal links: " + pathHost.innerHTML);
        }
        localPathLink.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        renderMarkdownWithCache(pathHost, "[打开图片](file:///C:/Users/lily/generated-assets/image.png)");
        const windowsFileUrlLink = pathHost.querySelector(".markdown-local-file-link[data-local-file-path]");
        if (!windowsFileUrlLink || windowsFileUrlLink.dataset.localFilePath !== "file:///C:/Users/lily/generated-assets/image.png") {
          throw new Error("Windows file URLs should be passed to main as file URLs, got: " + pathHost.innerHTML);
        }
        windowsFileUrlLink.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        renderMarkdownWithCache(pathHost, "![bad](/tmp/unauthorized-image.png)");
        const brokenLocalImage = pathHost.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/unauthorized-image.png']");
        if (!brokenLocalImage) {
          throw new Error("local image should initially render as a diagnosable local image: " + pathHost.innerHTML);
        }
        brokenLocalImage.dispatchEvent(new Event("error"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (pathHost.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/unauthorized-image.png']")) {
          throw new Error("failed local image should be replaced instead of staying as a broken image: " + pathHost.innerHTML);
        }
        const mediaError = pathHost.querySelector(".markdown-image-error[data-local-file-path='/tmp/unauthorized-image.png']");
        if (!mediaError || !mediaError.textContent.includes("NOT_AUTHORIZED")) {
          throw new Error("failed local image should show diagnostic status: " + pathHost.innerHTML);
        }
        renderMarkdownWithCache(pathHost, "![recovered](/tmp/generated-assets/image-stale.png)");
        const staleLocalImage = pathHost.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/generated-assets/image-stale.png']");
        if (!staleLocalImage) {
          throw new Error("stale local image should initially render as a diagnosable local image: " + pathHost.innerHTML);
        }
        staleLocalImage.dispatchEvent(new Event("error"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const recoveredLocalImage = pathHost.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/generated-assets/scene1.png']");
        if (!recoveredLocalImage || !String(recoveredLocalImage.getAttribute("src") || "").includes(encodeURIComponent("/tmp/generated-assets/scene1.png"))) {
          throw new Error("recoverable local image should update its preview src instead of becoming an error box: " + pathHost.innerHTML);
        }
        if (pathHost.querySelector(".markdown-image-error")) {
          throw new Error("recoverable local image must not leave an error box: " + pathHost.innerHTML);
        }
        renderMarkdownWithCache(pathHost, "![delayed](/tmp/generated-assets/delayed-markdown-image.png)");
        const delayedMarkdownImage = pathHost.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/generated-assets/delayed-markdown-image.png']");
        if (!delayedMarkdownImage) {
          throw new Error("delayed markdown local image should initially render as an image: " + pathHost.innerHTML);
        }
        delayedMarkdownImage.dispatchEvent(new Event("error"));
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (Number(delayedMarkdownImage.dataset.mediaRecoveryAttempts || "0") < 2) {
          throw new Error("delayed markdown local image should retry after initial NOT_FOUND: " + pathHost.innerHTML);
        }
        const recoveredDelayedMarkdownImage = pathHost.querySelector("img.markdown-local-file-image[data-local-file-path='/tmp/generated-assets/delayed-markdown-image.png']");
        if (!recoveredDelayedMarkdownImage || !String(recoveredDelayedMarkdownImage.getAttribute("src") || "").includes("?v=")) {
          throw new Error("delayed markdown local image should recover without waiting for a new message: " + pathHost.innerHTML);
        }
        renderMarkdownWithCache(pathHost, "已保存到：generated-assets/image-1-2026.png");
        const relativePathLink = pathHost.querySelector('.markdown-local-file-link[data-local-file-path="generated-assets/image-1-2026.png"]');
        if (relativePathLink) {
          throw new Error("relative generated-assets paths should not become reveal links: " + pathHost.innerHTML);
        }
        const rich = document.createElement("div");
        rich.className = "markdown-body";
        document.body.appendChild(rich);
        await renderMarkdown(rich, [
          "$$E=mc^2$$",
          fence + "mermaid",
          "graph TD",
          "A-->B",
          fence,
        ].join("\\n"));
        if (!rich.querySelector(".katex")) {
          throw new Error("KaTeX math should render in async markdown: " + rich.innerHTML);
        }
        if (!rich.querySelector(".markdown-mermaid svg")) {
          throw new Error("Mermaid blocks should render to SVG: " + rich.innerHTML);
        }
        const broken = document.createElement("div");
        broken.className = "markdown-body";
        document.body.appendChild(broken);
        await renderMarkdown(broken, [
          fence + "mermaid",
          "graph TD",
          "A -->",
          fence,
        ].join("\\n"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (document.body.textContent.includes("Syntax error in text")) {
          throw new Error("invalid Mermaid must not leak Mermaid's error SVG into the page body");
        }
        if (!broken.querySelector(".markdown-mermaid-error")) {
          throw new Error("invalid Mermaid should degrade inside the message: " + broken.innerHTML);
        }
        host.remove();
        pathShell.remove();
        rich.remove();
        broken.remove();
        return "markdown-rich-regression: ok";
      }
    )()`);
    console.log(markdownRichResult);
    if (!capturedRevealPaths.includes("session_markdown_reveal:/tmp/lily-output/generated image.png")) {
      throw new Error("local file path click should reveal in folder, got: " + capturedRevealPaths.join(","));
    }
    if (!capturedRevealPaths.includes("session_markdown_reveal:file:///C:/Users/lily/generated-assets/image.png")) {
      throw new Error("Windows file URL click should reveal via file URL, got: " + capturedRevealPaths.join(","));
    }
    if (capturedRevealPaths.some((path) => path.includes("generated-assets/image-1-2026.png"))) {
      throw new Error("relative generated path should not reveal, got: " + capturedRevealPaths.join(","));
    }
    const generatedMediaResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { appendToolPayloadDetail, generatedMediaFromPayload, parseGeneratedMedia } = await import("./modules/tool-payload-renderer.js");
        const output = '<generated_media type="image">\\n  <task_id>task_123</task_id>\\n  <file path="/tmp/generated image.png" bytes="1234" />\\n  <file path="generated-assets/image-1-2026.png" bytes="1234" />\\n</generated_media>';
        const parsed = parseGeneratedMedia(output);
        if (parsed.length !== 1 || parsed[0].type !== "image" || parsed[0].files[0].path !== "/tmp/generated image.png") {
          throw new Error("generated media parser did not extract image file");
        }
        const placeholder = '<generated_media type="image">\\n  <file path="/absolute/path/to/generated-assets/name.svg" bytes="1" />\\n</generated_media>';
        if (parseGeneratedMedia(placeholder).length !== 0) {
          throw new Error("placeholder generated_media paths must not become media blocks");
        }
        if (generatedMediaFromPayload({ content: "saved to /absolute/path/to/generated-assets/name.svg" }).length !== 0) {
          throw new Error("placeholder generated-assets fallback path must not become a media block");
        }
        const container = document.createElement("details");
        document.body.appendChild(container);
        const rendered = appendToolPayloadDetail(container, {
          name: "Bash",
          result: { content: output },
        }, { role: "result", sessionId: "session_media_reveal" });
        const img = container.querySelector(".assistant-generated-media img");
        if (!rendered || !img) {
          throw new Error("generated media result did not render image preview");
        }
        const mediaSrc = String(img.getAttribute("src") || "");
        if (!mediaSrc.startsWith("app-file://media/") || !decodeURIComponent(mediaSrc).includes("/tmp/generated")) {
          throw new Error("generated media preview should use the app-file:// scheme: " + mediaSrc);
        }
        if (container.textContent.includes("<generated_media")) {
          throw new Error("raw generated_media XML should not be shown to the user");
        }
        const absolutePath = [...container.querySelectorAll(".assistant-generated-media code")]
          .find((node) => node.textContent === "/tmp/generated image.png");
        if (!absolutePath || !absolutePath.classList.contains("is-clickable")) {
          throw new Error("absolute generated media path should be clickable");
        }
        const revealButton = container.querySelector(".assistant-generated-media .assistant-reveal-btn");
        if (!revealButton || !revealButton.querySelector("svg")) {
          throw new Error("generated media reveal action should be an icon button: " + container.innerHTML);
        }
        if (!revealButton.getAttribute("aria-label") || !revealButton.title) {
          throw new Error("generated media reveal icon must keep aria-label and tooltip");
        }
        if (/Show in folder|在目录中显示|在文件夹中显示/.test(revealButton.textContent || "")) {
          throw new Error("generated media reveal action should not repeat text in the row");
        }
        absolutePath.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const relativePath = [...container.querySelectorAll(".assistant-generated-media code")]
          .find((node) => node.textContent === "generated-assets/image-1-2026.png");
        if (!relativePath) {
          throw new Error("relative generated media path should be rendered");
        }
        if (relativePath.classList.contains("is-clickable")) {
          throw new Error("relative generated media path should not be clickable");
        }
        const staleOutput = '<generated_media type="image">\\n  <file path="/tmp/generated-assets/image-stale.png" bytes="1234" />\\n</generated_media>';
        const staleContainer = document.createElement("details");
        document.body.appendChild(staleContainer);
        appendToolPayloadDetail(staleContainer, {
          name: "Bash",
          result: { content: staleOutput },
        }, { role: "result", sessionId: "session_stale_media" });
        const staleImg = staleContainer.querySelector(".assistant-generated-media img[data-local-file-path='/tmp/generated-assets/image-stale.png']");
        if (!staleImg) {
          throw new Error("stale generated media image should render before recovery: " + staleContainer.innerHTML);
        }
        staleImg.dispatchEvent(new Event("error"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (staleImg.dataset.localFilePath !== "/tmp/generated-assets/scene1.png") {
          throw new Error("stale generated media image should recover to the resolved path: " + staleContainer.innerHTML);
        }
        if (!String(staleImg.getAttribute("src") || "").includes(encodeURIComponent("/tmp/generated-assets/scene1.png"))) {
          throw new Error("stale generated media image should update src to recovered app-file URL: " + staleContainer.innerHTML);
        }
        staleContainer.remove();
        const delayedOutput = '<generated_media type="image">\\n  <file path="/tmp/generated-assets/delayed-image.png" bytes="1234" />\\n</generated_media>';
        const delayedContainer = document.createElement("details");
        document.body.appendChild(delayedContainer);
        appendToolPayloadDetail(delayedContainer, {
          name: "Bash",
          result: { content: delayedOutput },
        }, { role: "result", sessionId: "session_delayed_media" });
        const delayedImg = delayedContainer.querySelector(".assistant-generated-media img[data-local-file-path='/tmp/generated-assets/delayed-image.png']");
        if (!delayedImg) {
          throw new Error("delayed generated media image should render before retry: " + delayedContainer.innerHTML);
        }
        delayedImg.dispatchEvent(new Event("error"));
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (Number(delayedImg.dataset.mediaRecoveryAttempts || "0") < 2) {
          throw new Error("delayed generated media should retry after initial NOT_FOUND: " + delayedContainer.innerHTML);
        }
        if (!String(delayedImg.getAttribute("src") || "").includes(encodeURIComponent("/tmp/generated-assets/delayed-image.png"))) {
          throw new Error("delayed generated media image should recover in-place without a new message: " + delayedContainer.innerHTML);
        }
        if (!String(delayedImg.getAttribute("src") || "").includes("?v=")) {
          throw new Error("delayed generated media recovery should cache-bust the original failed URL: " + delayedImg.getAttribute("src"));
        }
        delayedContainer.remove();
        container.remove();
        const placeholderContainer = document.createElement("details");
        document.body.appendChild(placeholderContainer);
        appendToolPayloadDetail(placeholderContainer, {
          name: "Bash",
          result: { content: placeholder },
        }, { role: "result", sessionId: "session_placeholder_media" });
        if (placeholderContainer.querySelector(".assistant-generated-media")) {
          throw new Error("placeholder generated media should not render a broken file area");
        }
        if (placeholderContainer.textContent.includes("<generated_media")) {
          throw new Error("invalid generated_media marker should not leak raw XML");
        }
        placeholderContainer.remove();
        return "generated-media-preview-regression: ok";
      }
    )()`);
    console.log(generatedMediaResult);
    const windowsGeneratedMediaResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { appendToolPayloadDetail } = await import("./modules/tool-payload-renderer.js");
        const container = document.createElement("details");
        document.body.appendChild(container);
        const winPath = "C:\\\\Users\\\\ROG\\\\Desktop\\\\Lily\\\\交互模块\\\\generated-assets\\\\test_linzhi.wav";
        const output = '<generated_media type="speech">\\n  <file path="' + winPath + '" bytes="4321" />\\n</generated_media>';
        const rendered = appendToolPayloadDetail(container, {
          name: "Bash",
          result: { content: output },
        }, { role: "result", sessionId: "session_windows_media_reveal" });
        const audio = container.querySelector(".assistant-generated-media audio");
        if (!rendered || !audio) {
          throw new Error("windows speech generated media should render an audio player");
        }
        const mediaSrc = String(audio.getAttribute("src") || "");
        if (!mediaSrc.startsWith("app-file://media/") || !decodeURIComponent(mediaSrc).includes(winPath)) {
          throw new Error("windows generated media src should preserve the exact Chinese path: " + mediaSrc);
        }
        const pathNode = [...container.querySelectorAll(".assistant-generated-media code")]
          .find((node) => node.textContent === winPath);
        if (!pathNode || !pathNode.classList.contains("is-clickable")) {
          throw new Error("windows generated media path should be clickable without rewriting: " + container.innerHTML);
        }
        const fileUrlContainer = document.createElement("details");
        document.body.appendChild(fileUrlContainer);
        const winFileUrl = "file:///C:/Users/ROG/Desktop/Lily/%E4%BA%A4%E4%BA%92%E6%A8%A1%E5%9D%97/generated-assets/test_linzhi.png";
        appendToolPayloadDetail(fileUrlContainer, {
          name: "Bash",
          result: { content: '<generated_media type="image">\\n  <file path="' + winFileUrl + '" bytes="4321" />\\n</generated_media>' },
        }, { role: "result", sessionId: "session_windows_file_url_media" });
        const fileUrlImg = fileUrlContainer.querySelector(".assistant-generated-media img");
        if (!fileUrlImg) {
          throw new Error("windows file URL generated media should render an image preview");
        }
        const fileUrlSrc = decodeURIComponent(String(fileUrlImg.getAttribute("src") || ""));
        if (!fileUrlSrc.startsWith("app-file://media/C:/Users/ROG/Desktop/Lily/交互模块/")) {
          throw new Error("windows Chinese file URL should normalize without a leading slash: " + fileUrlSrc);
        }
        fileUrlContainer.remove();
        pathNode.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        container.remove();
        return "windows-generated-media-path-regression: ok";
      }
    )()`);
    console.log(windowsGeneratedMediaResult);
    if (!capturedRevealPaths.includes("session_media_reveal:/tmp/generated image.png")) {
      throw new Error("absolute generated media path should reveal, got: " + capturedRevealPaths.join(","));
    }
    if (!capturedRevealPaths.includes("session_windows_media_reveal:C:\\Users\\ROG\\Desktop\\Lily\\交互模块\\generated-assets\\test_linzhi.wav")) {
      throw new Error("windows generated media path should reveal exactly, got: " + capturedRevealPaths.join(","));
    }
    if (capturedRevealPaths.some((path) => path.includes("generated-assets/image-1-2026.png"))) {
      throw new Error("relative generated media path should not reveal, got: " + capturedRevealPaths.join(","));
    }
    const generatedFileImageResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { appendToolPayloadDetail } = await import("./modules/tool-payload-renderer.js");
        const container = document.createElement("details");
        document.body.appendChild(container);
        const rendered = appendToolPayloadDetail(container, {
          name: "Bash",
          result: { content: JSON.stringify({ ok: true, output: "/tmp/out/icon.svg" }) },
        }, { role: "result", sessionId: "session_generated_file_image" });
        // Top-tier: a file path returned in a tool's JSON must NOT inline-render as an
        // image — only the explicit <generated_media> contract previews. It gets a
        // reveal file chip instead, so incidental/referenced image paths never render.
        if (container.querySelector(".assistant-generated-files img")) {
          throw new Error("svg field output must NOT inline-render as an image (only <generated_media> previews)");
        }
        const path = container.querySelector(".assistant-generated-file-path");
        if (!rendered || !path || path.textContent !== "/tmp/out/icon.svg") {
          throw new Error("svg field output should render a reveal file chip: " + container.innerHTML);
        }
        if (!path.classList.contains("is-clickable")) {
          throw new Error("svg field output path should be clickable to reveal");
        }
        const revealButton = container.querySelector(".assistant-generated-file-row .assistant-reveal-btn");
        if (!revealButton || !revealButton.querySelector("svg")) {
          throw new Error("svg field output reveal action should be an icon button: " + container.innerHTML);
        }
        path.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        container.remove();
        return "generated-file-svg-preview-regression: ok";
      }
    )()`);
    console.log(generatedFileImageResult);
    if (!capturedRevealPaths.includes("session_generated_file_image:/tmp/out/icon.svg")) {
      throw new Error("generated SVG output path should reveal, got: " + capturedRevealPaths.join(","));
    }
    const workspaceAppInstallUxResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { refreshWorkspaceApps } = await import("./modules/workspace-apps.js");
        const list = document.getElementById("workspaceAppsList");
        if (!list) throw new Error("workspace app list should exist");
        await refreshWorkspaceApps();
        const text = list.textContent || "";
        if (!text.includes("Create workspace") && !text.includes("创建工作空间")) {
          throw new Error("install action should be framed as creating a workspace");
        }
        if (!text.includes("/tmp/Lily Apps/Installed App")) {
          throw new Error("installed app card should show its workspace path");
        }
        if (!text.includes("Show in folder") && !text.includes("在文件夹中显示")) {
          throw new Error("installed app card should expose a reveal-in-folder action");
        }
        if (!text.includes("New workspace") && !text.includes("新建工作空间")) {
          throw new Error("installed app card should allow creating another workspace instance");
        }
        if (!text.includes("2 workspaces") && !text.includes("2 个工作空间")) {
          throw new Error("installed app card should show multiple workspace instances");
        }
        return "workspace-app-install-ux: ok";
      }
    )()`);
    console.log(workspaceAppInstallUxResult);
    if (capturedQuestionResponses.length !== 1) {
      throw new Error(`multi-select should submit exactly once, got ${capturedQuestionResponses.length}`);
    }
    const questionPayload = capturedQuestionResponses[0];
    if (questionPayload.requestId !== "req_question_multi") {
      throw new Error(`wrong request id submitted: ${questionPayload.requestId}`);
    }
    if (!Array.isArray(questionPayload.answers?.mode) || questionPayload.answers.mode.join(",") !== "Fast,Careful") {
      throw new Error(`multi-select answers should submit an array: ${JSON.stringify(questionPayload.answers)}`);
    }
    if (questionPayload.response !== "Fast\nCareful") {
      throw new Error(`multi-select response summary should include selected values: ${questionPayload.response}`);
    }
    const accountLoginBridgeResult = await win.webContents.executeJavaScript(`(
      async () => {
        await window.assistantClient.loginAccountWithSms({ phone: "13800000000", code: "123456" });
        return "account-login-bridge-contract: ok";
      }
    )()`);
    console.log(accountLoginBridgeResult);
    const accountLoginPayload = capturedAccountLoginPayloads[0] || {};
    if (accountLoginPayload.phone !== "13800000000" || accountLoginPayload.code !== "123456") {
      throw new Error("account login bridge should preserve object payload: " + JSON.stringify(accountLoginPayload));
    }
    const accountLoggedInUiResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { refreshAccountSettings } = await import("./modules/account-settings.js");
        await refreshAccountSettings();
        const loginContent = document.getElementById("accountLoginContent");
        const signedInPanel = document.getElementById("accountSignedInPanel");
        const signedInPhone = document.getElementById("accountSignedInPhone");
        const actions = document.querySelector(".account-management-actions");
        if (!loginContent?.hidden) throw new Error("logged-in account should hide SMS login fields");
        if (signedInPanel?.hidden) throw new Error("logged-in account should show signed-in panel");
        if (actions?.hidden) throw new Error("logged-in account should show billing/logout actions");
        if (!String(signedInPhone?.textContent || "").includes("+8618210178959")) {
          throw new Error("signed-in panel should show the current phone");
        }
        return "account-logged-in-ui: ok";
      }
    )()`);
    console.log(accountLoggedInUiResult);
    const settingsSingleResponsibilityResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { openSettingsPage } = await import("./modules/settings-panel.js");
        const visible = (id) => {
          const el = document.getElementById(id);
          if (!el) throw new Error("missing settings page element: " + id);
          const page = el.classList.contains("settings-page") ? el : el.closest(".settings-page");
          return Boolean(page && !page.hidden);
        };
        openSettingsPage("account");
        if (!visible("accountPanelOverview")) throw new Error("account should open on overview tab");
        if (visible("settingsPageUsage")) throw new Error("usage should not be stacked under account");
        if (visible("settingsPageLicense")) throw new Error("license should not be stacked under account overview");
        if (visible("settingsPageFeedback") || visible("settingsPageContact") || visible("settingsPageAbout")) {
          throw new Error("help panels should stay hidden on the account page");
        }
        document.querySelector('[data-settings-link="usage"]').click();
        if (!visible("settingsPageUsage")) throw new Error("usage page should show usage panel");
        if (visible("accountPanelOverview") || visible("settingsPageLicense")) {
          throw new Error("usage page should hide account overview and license panels");
        }
        openSettingsPage("license");
        if (!visible("settingsPageLicense")) throw new Error("license page should show license panel");
        if (visible("accountPanelOverview") || visible("settingsPageUsage")) {
          throw new Error("license page should hide account overview and usage panels");
        }
        openSettingsPage("help");
        if (!visible("settingsPageAbout")) throw new Error("help nav should default to about page");
        if (visible("settingsPageHelp") || visible("settingsPageFeedback") || visible("settingsPageContact")) {
          throw new Error("help nav should not stack help/feedback/contact panels when defaulting to about");
        }
        document.querySelector('[data-settings-link="feedback"]').click();
        if (!visible("settingsPageFeedback")) throw new Error("feedback page should show feedback panel");
        if (visible("settingsPageContact") || visible("settingsPageAbout")) {
          throw new Error("support sections should not be stacked");
        }
        if (visible("accountPanelOverview") || visible("settingsPageUsage") || visible("settingsPageLicense")) {
          throw new Error("account panels should stay hidden on the feedback page");
        }
        openSettingsPage("contact");
        if (!visible("settingsPageContact")) throw new Error("contact page should show contact panel");
        if (visible("settingsPageFeedback") || visible("settingsPageAbout")) {
          throw new Error("contact page should hide feedback and about panels");
        }
        openSettingsPage("about");
        if (!visible("settingsPageAbout")) throw new Error("about page should show about panel");
        if (visible("settingsPageFeedback") || visible("settingsPageContact")) {
          throw new Error("about page should hide feedback and contact panels");
        }
        openSettingsPage("account");
        if (visible("settingsPageFeedback") || visible("settingsPageContact") || visible("settingsPageAbout")) {
          throw new Error("help panels should remain hidden after returning to account");
        }
        return "settings-single-responsibility-pages: ok";
      }
    )()`);
    console.log(settingsSingleResponsibilityResult);
    const runtimePolicySettingsResult = await win.webContents.executeJavaScript(`(
      async () => {
        window.__lilyAppPolicy = {
          ok: true,
          region: "uae",
          features: {
            account: false,
            accountLogin: false,
            billing: false,
            purchase: false,
            usage: true,
            licenseActivation: true,
          },
        };
        const { applyAppPolicyToSettings, openSettingsPage } = await import("./modules/settings-panel.js");
        applyAppPolicyToSettings(window.__lilyAppPolicy);
        const usageNav = document.querySelector('.settings-nav-item[data-edition-account-nav="true"]');
        if (!usageNav || usageNav.hidden || usageNav.dataset.settingsPage !== "usage") {
          throw new Error("UAE policy should keep the account group as usage navigation");
        }
        if (!document.querySelector('[data-settings-link="account"]')?.hidden) {
          throw new Error("UAE policy should hide account login tab");
        }
        if (document.querySelector('[data-settings-link="usage"]')?.hidden) {
          throw new Error("UAE policy should keep usage tab visible");
        }
        openSettingsPage("account");
        const accountPage = document.getElementById("settingsPageAccount");
        if (accountPage && !accountPage.hidden) throw new Error("UAE policy should not open account page");
        if (document.getElementById("settingsPageUsage")?.hidden) {
          throw new Error("UAE policy should redirect account page requests to usage");
        }
        if (!document.querySelector(".account-usage-balance")?.hidden) {
          throw new Error("UAE policy should hide account entitlement balance on usage page");
        }
        openSettingsPage("license");
        if (document.getElementById("settingsPageLicense")?.hidden) {
          throw new Error("UAE policy should keep license activation page available");
        }
        window.__lilyAppPolicy = { ok: true, region: "china", features: { accountLogin: true, purchase: true } };
        applyAppPolicyToSettings(window.__lilyAppPolicy);
        return "runtime-policy-settings: ok";
      }
    )()`);
    console.log(runtimePolicySettingsResult);
    console.log("test-renderer-import: ok");
  }
  finish(app.exitCode || 0);
}).catch((err) => {
  console.error(err?.stack || err?.message || err);
  finish(1);
});
