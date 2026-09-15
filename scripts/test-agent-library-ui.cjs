#!/usr/bin/env node
"use strict";

/**
 * Electron DOM tests for the 智能体 (agent) management UI:
 * the library dialog's default agents tab (official + installed + distributed
 * with badges, capability chips, install-and-use with CAS + conflict retry,
 * degraded receipt notice, deactivate, distributed-pending notice, BUSY, kill
 * switch), "让 Lily 创建" authoring marker kind "agent", the composer popover's
 * agent section (every agent listed + explainer + capability chips + role
 * heading note) + banner, a role pick that releases the agent
 * (`agentDeactivated`), the in-conversation agent-binding platform card and
 * the "由智能体「X」回答" label, starter chips for an empty conversation, and
 * the sidebar agent mark. The agents:* IPC channels are mocked in main; the UI
 * runs against the real index.html DOM and preload bridge.
 *
 * Run: npx electron scripts/test-agent-library-ui.cjs
 */

const electron = require("electron");
const { app, BrowserWindow, ipcMain } = electron;
const fs = require("node:fs");
const path = require("node:path");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error("test-agent-library-ui must run under Electron. Use: npx electron scripts/test-agent-library-ui.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
let win;

const hardTimeout = setTimeout(() => {
  console.error("test-agent-library-ui: timed out");
  try { win?.destroy?.(); } catch { /* best effort */ }
  app.exit(1);
  process.exit(1);
}, Number(process.env.TEST_AGENT_LIBRARY_TIMEOUT_MS || 120000));

function finish(code = app.exitCode || 0) {
  clearTimeout(hardTimeout);
  try { win?.destroy?.(); } catch { /* best effort */ }
  app.exit(code);
  setTimeout(() => process.exit(code), 250).unref?.();
}

// --- Mock workspace shell ----------------------------------------------------
const SESSION_ID = "session_alpha_recent";
const rendererProjects = [
  {
    id: "project_alpha",
    name: "Alpha Workspace",
    path: "/tmp/Alpha Workspace",
    sessions: [
      { id: SESSION_ID, title: "Alpha recent discussion", createdAt: "2026-07-24T08:00:00.000Z", updatedAt: "2026-07-25T08:00:00.000Z" },
      { id: "session_with_agent", title: "Contract review", agent: { id: "agent_legal", name: "合同审查助手", icon: "🧭" }, createdAt: "2026-07-24T08:00:00.000Z", updatedAt: "2026-07-24T09:00:00.000Z" },
    ],
  },
];

// --- Mock agents backend (src/main/ipc-agents.js shapes) ---------------------
const summary = (name, extra = {}) => ({
  schemaVersion: 1, name, description: `${name}：把常见任务交给它。`, icon: "🧭", tags: ["合同"],
  role: null, starters: [`用${name}审这份合同`, "总结主要风险", "起草一封回复"],
  skills: { required: ["lily-doc-review"], enabled: ["lily-web-search"] },
  knowledge: { packs: ["legal-cn"], guidance: "" }, model: { presetId: "" },
  tools: { mcpAllow: ["lily_legal_search"], connectors: [], disallow: [] },
  autonomy: { permissionModeId: "ask" }, automations: [], dimensions: ["role", "skills"], cold: false, ...extra,
});

const agentsState = {
  binding: { bindingVersion: 3, agentId: null, agentRevisionId: null, displayName: "", receipt: null, updatedAt: null },
  listBehavior: "ok", // "ok" | "disabled"
  activateBehavior: "ok", // "ok" | "conflict-once" | "busy"
  degradedNext: false,
  conflicted: false,
  agents: [
    { id: "agent_local", name: "我的助理", icon: "", description: "我的助理：把常见任务交给它。", official: false, officialId: null, currentRevisionId: "rev_l1", revisionNumber: 1, sourceKind: "agent_draft", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", archivedAt: null, inUse: 0, summary: summary("我的助理", { icon: "", autonomy: { permissionModeId: "inherit" } }) },
    { id: "agent_legal", name: "合同审查助手", icon: "🧭", description: "合同审查助手：把常见任务交给它。", official: true, officialId: "lily-contract-review", currentRevisionId: "rev_o1", revisionNumber: 1, sourceKind: "official", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z", archivedAt: null, inUse: 0, summary: summary("合同审查助手") },
  ],
  official: [
    { id: "lily-contract-review", version: 1, locale: "zh-CN", categoryId: "legal-finance", category: "法务与财务", editorialOrder: 1, featured: true, roleOfficialId: "lily-cn-legal-counsel", official: true, summary: summary("合同审查助手") },
    { id: "lily-weekly-report", version: 1, locale: "zh-CN", categoryId: "work-delivery", category: "工作与交付", editorialOrder: 2, featured: true, roleOfficialId: null, official: true, summary: summary("周报助手", { icon: "📝", autonomy: { permissionModeId: "full" }, model: { presetId: "deepseek-v4-pro" } }) },
  ],
  distributed: [
    { packageId: "pkg_1", agentId: "org-onboarding", version: 3, scope: "organization", publisher: "ACME", featured: false, isDefault: true, installedAgentId: null, summary: summary("入职向导", { icon: "🏢" }) },
  ],
  knowledgePacks: [{ id: "legal-cn", name: "中国法律知识包" }],
};
const calls = [];
const record = (channel, payload) => calls.push({ channel, payload });

function libraryItem(agent) { return agent ? { ...agent } : null; }

ipcMain.handle("agents:list", (_e, payload) => {
  record("agents:list", payload);
  if (agentsState.listBehavior === "disabled") return { ok: true, disabled: true, agents: [], official: [], knowledgePacks: [] };
  const installed = new Map(agentsState.agents.filter((a) => a.officialId).map((a) => [a.officialId, a]));
  return {
    ok: true,
    agents: agentsState.agents.filter((a) => payload?.includeArchived || !a.archivedAt).map(libraryItem),
    official: agentsState.official.map((o) => ({
      ...o,
      installedAgentId: installed.get(o.id)?.id || null,
      currentRevisionId: installed.get(o.id)?.currentRevisionId || null,
      installedVersion: installed.get(o.id) ? 1 : 0,
      updateAvailable: false,
    })),
    distributed: agentsState.distributed,
    defaultAgentId: "org-onboarding",
    knowledgePacks: agentsState.knowledgePacks,
  };
});
ipcMain.handle("agents:get-session", (_e, payload) => {
  record("agents:get-session", payload);
  if (payload?.sessionId !== SESSION_ID) return { ok: false, error: "NO_SESSION" };
  const agent = agentsState.agents.find((a) => a.id === agentsState.binding.agentId) || null;
  return { ok: true, enabled: agentsState.listBehavior !== "disabled", binding: { ...agentsState.binding }, agent: libraryItem(agent), updateAvailable: false, active: Boolean(agent) };
});
ipcMain.handle("agents:activate", (_e, payload) => {
  record("agents:activate", payload);
  if (agentsState.activateBehavior === "busy") return { ok: false, error: "BUSY" };
  if (agentsState.activateBehavior === "conflict-once" && !agentsState.conflicted) {
    agentsState.conflicted = true;
    agentsState.binding.bindingVersion += 1; // someone else moved it
    return { ok: false, error: "AGENT_BINDING_CONFLICT", currentBindingVersion: agentsState.binding.bindingVersion };
  }
  if (payload.expectedBindingVersion != null && payload.expectedBindingVersion !== agentsState.binding.bindingVersion) {
    return { ok: false, error: "AGENT_BINDING_CONFLICT", currentBindingVersion: agentsState.binding.bindingVersion };
  }
  let agent = agentsState.agents.find((a) => a.id === payload.agentId);
  if (!agent && payload.officialId) {
    const official = agentsState.official.find((o) => o.id === payload.officialId);
    if (!official) return { ok: false, error: "AGENT_OFFICIAL_UNKNOWN" };
    agent = agentsState.agents.find((a) => a.officialId === official.id);
    if (!agent) {
      agent = { id: `agent_${official.id.replace(/^lily-/, "").replace(/-/g, "_")}`, name: official.summary.name, icon: official.summary.icon, description: official.summary.description, official: true, officialId: official.id, currentRevisionId: `rev_${official.id}`, revisionNumber: 1, sourceKind: "official", createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z", archivedAt: null, inUse: 0, summary: official.summary };
      agentsState.agents.push(agent);
    }
  }
  if (!agent) return { ok: false, error: "AGENT_NOT_FOUND" };
  agentsState.binding = { ...agentsState.binding, bindingVersion: agentsState.binding.bindingVersion + 1, agentId: agent.id, agentRevisionId: agent.currentRevisionId, displayName: agent.name };
  const degraded = agentsState.degradedNext ? [{ dimension: "model", reason: "preset_unavailable" }, { dimension: "tools", reason: "lite" }] : [];
  agentsState.degradedNext = false;
  const receipt = { role: { status: "applied" }, skills: { status: "applied" }, autonomy: { status: "applied" }, knowledge: { status: "skipped" }, model: { status: degraded.length ? "degraded" : "applied" }, tools: { status: degraded.length ? "degraded" : "applied" }, automations: { status: "skipped" }, degraded, coldApplied: false };
  return { ok: true, binding: { ...agentsState.binding }, receipt, agent: libraryItem(agent) };
});
ipcMain.handle("agents:deactivate", (_e, payload) => {
  record("agents:deactivate", payload);
  if (payload.expectedBindingVersion != null && payload.expectedBindingVersion !== agentsState.binding.bindingVersion) {
    return { ok: false, error: "AGENT_BINDING_CONFLICT", currentBindingVersion: agentsState.binding.bindingVersion };
  }
  agentsState.binding = { ...agentsState.binding, bindingVersion: agentsState.binding.bindingVersion + 1, agentId: null, agentRevisionId: null, displayName: "" };
  return { ok: true, binding: { ...agentsState.binding }, restored: true };
});
ipcMain.handle("agents:export", (_e, payload) => { record("agents:export", payload); return { ok: true, fileName: "x.lily-agent.json" }; });
ipcMain.handle("agents:import", (_e, payload) => { record("agents:import", payload); return { ok: false, error: "CANCELED" }; });
ipcMain.handle("agents:archive", (_e, payload) => {
  record("agents:archive", payload);
  const agent = agentsState.agents.find((a) => a.id === payload.agentId);
  if (!agent) return { ok: false, error: "AGENT_NOT_FOUND" };
  agent.archivedAt = payload.action === "restore" ? null : "2026-09-14T01:00:00Z";
  return { ok: true, agent: libraryItem(agent) };
});
ipcMain.handle("agents:install-official", () => ({ ok: false, error: "AGENTS_UNAVAILABLE" }));
ipcMain.handle("agents:knowledge-packs", () => ({ ok: true, packs: agentsState.knowledgePacks }));

// --- Minimal character-worlds mocks (role control must keep working) ---------
ipcMain.handle("character:list", () => ({ ok: true, characters: [] }));
ipcMain.handle("character:list-official", () => ({ ok: true, characters: [] }));
ipcMain.handle("character:get", () => ({ ok: false, error: "CHARACTER_NOT_FOUND" }));
ipcMain.handle("character:get-revision", () => ({ ok: false, error: "CHARACTER_REVISION_NOT_FOUND" }));
ipcMain.handle("session-character:get-binding", (_e, payload) => ({
  ok: true,
  binding: { schemaVersion: 1, sessionId: payload?.sessionId || "", mode: "native", bindingVersion: 0, characterRevisionId: null, compatibilityProfile: null },
}));
// A role pick releases the bound agent: main reports it as `agentDeactivated`.
let cwBindingVersion = 0;
ipcMain.handle("session-character:set-binding", (_e, payload) => {
  record("session-character:set-binding", payload);
  cwBindingVersion += 1;
  const res = {
    ok: true,
    binding: { schemaVersion: 1, sessionId: payload?.sessionId || "", mode: payload?.mode || "native", bindingVersion: cwBindingVersion, characterRevisionId: payload?.characterRevisionId || null, compatibilityProfile: null },
  };
  const agent = agentsState.agents.find((a) => a.id === agentsState.binding.agentId);
  if (agent) {
    agentsState.binding = { ...agentsState.binding, bindingVersion: agentsState.binding.bindingVersion + 1, agentId: null, agentRevisionId: null, displayName: "" };
    res.agentDeactivated = { agentId: agent.id, name: agent.name, bindingVersion: agentsState.binding.bindingVersion };
  }
  return res;
});
ipcMain.handle("session-character:get-events", () => ({ ok: true, events: [] }));
ipcMain.handle("scene:get", () => ({ ok: false, error: "FEATURE_DISABLED" }));
ipcMain.handle("character-worlds:preview-get", () => ({ ok: false, error: "FEATURE_DISABLED" }));
ipcMain.handle("character:greetings", () => ({ ok: true, greetings: [] }));

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
  projects: rendererProjects, activeProjectId: "project_alpha", activeSessionId: SESSION_ID, conversation: [], runtime: { sessions: {} }, settings: {},
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

function check(label, condition, detail = "") {
  if (condition) console.log(`${label}: ok${detail ? ` — ${detail}` : ""}`);
  else { console.error(`${label}: FAIL ${detail}`); app.exitCode = 1; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(root, "src/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on("console-message", (_e, _level, msg) => {
    if (/does not provide an export|Uncaught|SyntaxError/.test(String(msg))) console.error("CONSOLE:", msg);
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await wait(1800);

  // 0. Every new key resolves in all three locales (main-side, no DOM needed).
  {
    const viewSrc = fs.readFileSync(path.join(root, "src/renderer/modules/agent-library-view.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/agent-library-actions.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/agent-session-section.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/agent-library-model.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/character-library-view.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/character-role-list-view.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/character-session-control.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/agent-binding-notice-view.js"), "utf8")
      + fs.readFileSync(path.join(root, "src/renderer/modules/project-tree.js"), "utf8");
    const keys = [...new Set([...viewSrc.matchAll(/"(character\.(?:agent|library)\.[A-Za-z0-9_.-]+)"/g)].map((m) => m[1]))]
      .filter((key) => key.startsWith("character.agent.") || /tabAgents|aiCreateAgentPrompt|facetHintAgent|groupDistributed|selectHintAgent/.test(key))
      .concat(["character.agent.sectionExplainer", "character.agent.roleHeadingNote", "character.agent.replacedByRole",
        "message.answeredByAgent", "character.popoverTitle", "character.buttonTitle", "character.roleBannerTitle"]);
    const missing = [];
    for (const locale of ["zh-CN", "en", "ar"]) {
      const data = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/i18n/locales/${locale}.json`), "utf8"));
      for (const key of keys) if (typeof data[key] !== "string" || !data[key].trim()) missing.push(`${locale}:${key}`);
    }
    check("locales-resolve-new-keys", keys.length >= 40 && missing.length === 0, missing.length ? missing.join(", ") : `${keys.length} keys × 3 locales`);
    const zh = JSON.parse(fs.readFileSync(path.join(root, "src/renderer/i18n/locales/zh-CN.json"), "utf8"));
    check("popover-title-copy", zh["character.popoverTitle"] === "角色与智能体" && zh["character.buttonTitle"] === "角色与智能体" && zh["character.roleBannerTitle"].includes("智能体"), `${zh["character.popoverTitle"]} / ${zh["character.roleBannerTitle"]}`);
    const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
    check("popover-title-html-fallback", html.includes('data-i18n="character.popoverTitle">角色与智能体<') && !html.includes(">对话角色<"), "static fallback copy renamed");
  }

  // 1. Modules load.
  await run("module-import", `(async () => {
    const lib = await import("./modules/character-library.js");
    const model = await import("./modules/agent-library-model.js");
    const section = await import("./modules/agent-session-section.js");
    const starters = await import("./modules/agent-starters.js");
    for (const [mod, names] of [[lib, ["openCharacterLibrary", "startAiAuthoring", "getCharacterLibraryState"]], [model, ["buildAgentLibraryItems", "shortlistAgents"]], [section, ["createAgentSessionSection"]], [starters, ["initAgentStarters", "refreshAgentStarters"]]]) {
      for (const name of names) if (typeof mod[name] !== "function") throw new Error("missing export " + name);
    }
    return "exports present";
  })()`);

  // 2. Default tab is agents; official + installed + distributed rows with badges.
  await run("default-agents-tab", `(async () => {
    const lib = await import("./modules/character-library.js");
    await lib.openCharacterLibrary();
    await new Promise((r) => setTimeout(r, 300));
    const modal = document.getElementById("characterLibraryModal");
    if (modal.hidden) throw new Error("library should open");
    const tabs = [...document.querySelectorAll("#characterLibraryTabs [role='tab']")];
    if (tabs[0]?.dataset.libraryTab !== "agents" || tabs[0].getAttribute("aria-selected") !== "true") throw new Error("agents must be the first, selected tab");
    if (tabs[1]?.dataset.libraryTab !== "characters") throw new Error("characters tab must stay second");
    const groups = [...document.querySelectorAll("#characterLibraryGroups [data-library-group]")].map((g) => g.dataset.libraryGroup);
    for (const id of ["featured", "all", "official", "distributed", "my", "recent", "archived"]) if (!groups.includes(id)) throw new Error("group missing: " + id);
    document.querySelector("[data-library-group='all']").click();
    await new Promise((r) => setTimeout(r, 120));
    const rows = [...document.querySelectorAll("#characterLibraryGrid [data-entity-id]")];
    const byText = (s) => rows.find((r) => r.textContent.includes(s));
    if (rows.length !== 4) throw new Error("expected 4 agent rows, got " + rows.length + ": " + rows.map((r) => r.dataset.entityId).join(","));
    const legal = byText("合同审查助手"), weekly = byText("周报助手"), mine = byText("我的助理"), org = byText("入职向导");
    if (!legal || !weekly || !mine || !org) throw new Error("rows missing");
    if (legal.dataset.entityId !== "agent_legal") throw new Error("installed official row must use the local entity id");
    if (!legal.textContent.includes("官方")) throw new Error("official badge missing");
    if (legal.querySelector("[data-agent-marker='icon']")?.textContent !== "🧭") throw new Error("icon marker should show the emoji");
    if (mine.querySelector("[data-agent-marker='monogram']")?.textContent !== "我") throw new Error("monogram fallback for icon-less agents");
    if (!mine.textContent.includes("Lily 起草") || !mine.textContent.includes("我的")) throw new Error("agent_draft row needs Lily 起草 + 我的 badges");
    if (!org.textContent.includes("企业") || !org.textContent.includes("默认")) throw new Error("distributed row needs 企业 + 默认 badges");
    if (weekly.dataset.entityId !== "official:lily-weekly-report") throw new Error("not-installed official uses official: id");
    const facet = document.getElementById("characterLibraryFacetHint").textContent;
    if (!facet.includes("智能体")) throw new Error("facet hint must describe agents: " + facet);
    if (document.getElementById("characterLibraryImportBtn").textContent !== "导入智能体") throw new Error("import label per tab");
    if (!document.getElementById("characterLibrarySourceFilter").hidden) throw new Error("source select hidden on agents tab");
    return "rows=" + rows.length;
  })()`);

  // 3. Detail: capability chips + install-and-use label for a not-installed official agent.
  await run("detail-capability-chips", `(async () => {
    document.querySelector("[data-entity-id='official:lily-weekly-report'] [data-library-select]").click();
    await new Promise((r) => setTimeout(r, 150));
    const detail = document.getElementById("characterLibraryDetail");
    if (detail.dataset.libraryDetailKind !== "agent") throw new Error("detail kind should be agent");
    const cap = (key) => detail.querySelector("[data-agent-capability='" + key + "']")?.textContent || "";
    if (!cap("skills").includes("lily-doc-review") || !cap("skills").includes("lily-web-search")) throw new Error("skills chips: " + cap("skills"));
    if (!cap("knowledge").includes("中国法律知识包")) throw new Error("knowledge pack name chip: " + cap("knowledge"));
    if (!cap("tools").includes("lily_legal_search")) throw new Error("tools chip");
    if (!cap("autonomy").includes("全自主")) throw new Error("autonomy label: " + cap("autonomy"));
    if (!cap("model").includes("deepseek-v4-pro")) throw new Error("model preset chip: " + cap("model"));
    const starters = detail.querySelector("[data-agent-section='starters']");
    if (!starters || starters.querySelectorAll("li").length !== 3) throw new Error("3 starters listed");
    const primary = detail.querySelector("[data-library-activate]");
    if (!primary || primary.dataset.agentPrimary !== "install" || primary.textContent !== "安装并应用") throw new Error("primary should be 安装并应用: " + primary?.textContent);
    if (detail.querySelector("[data-library-action='export']")) throw new Error("not-installed agents have no export");
    return "chips + install label";
  })()`);

  // 4. Install-and-use → activate(sessionId, officialId, CAS); degraded receipt notice stays visible.
  agentsState.degradedNext = true;
  await run("install-and-use-degraded", `(async () => {
    document.querySelector("#characterLibraryDetail [data-library-activate]").click();
    await new Promise((r) => setTimeout(r, 400));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("部分能力未生效")) throw new Error("degraded notice must be visible: " + notice.textContent);
    if (!notice.textContent.includes("模型") || !notice.textContent.includes("工具")) throw new Error("degraded dimensions must be named: " + notice.textContent);
    if (!notice.textContent.includes("周报助手")) throw new Error("notice names the agent");
    if (document.getElementById("characterLibraryModal").hidden) throw new Error("a degraded activation keeps the dialog open");
    const live = document.getElementById("characterLibraryLive").textContent;
    if (!live.includes("部分能力未生效")) throw new Error("aria-live announces degradation");
    const row = document.querySelector("#characterLibraryGrid [data-entity-id='agent_weekly_report']");
    if (!row || !row.textContent.includes("当前生效")) throw new Error("installed+active row shows 当前生效 badge");
    const banner = document.getElementById("sessionRoleBanner");
    return "banner=" + banner.querySelector(".session-role-banner-name").textContent;
  })()`);
  {
    const activate = calls.filter((c) => c.channel === "agents:activate");
    const last = activate.at(-1)?.payload;
    check("activate-cas-payload", activate.length === 1 && last?.sessionId === SESSION_ID && last?.officialId === "lily-weekly-report" && !last?.agentId && last?.expectedBindingVersion === 3, JSON.stringify(last));
  }

  // 5. Banner reflects the bound agent; deactivate path from the detail pane.
  await run("banner-and-deactivate", `(async () => {
    await new Promise((r) => setTimeout(r, 200));
    const banner = document.getElementById("sessionRoleBanner");
    if (!banner.classList.contains("is-agent")) throw new Error("banner should mark the agent binding");
    if (banner.querySelector(".session-role-banner-name").textContent !== "周报助手") throw new Error("banner shows agent name, got " + banner.querySelector(".session-role-banner-name").textContent);
    if (banner.querySelector(".session-role-banner-avatar").textContent !== "📝") throw new Error("banner shows agent icon");
    if ((banner.title.match(/当前智能体/g) || []).length !== 1) throw new Error("banner title decorated exactly once: " + banner.title);
    document.querySelector("#characterLibraryGrid [data-entity-id='agent_weekly_report'] [data-library-select]").click();
    await new Promise((r) => setTimeout(r, 150));
    const detail = document.getElementById("characterLibraryDetail");
    const remove = detail.querySelector("[data-library-deactivate]");
    if (!remove || remove.textContent !== "从当前会话移除") throw new Error("active agent primary must be 从当前会话移除");
    if (!detail.querySelector("[data-library-action='export']") || !detail.querySelector("[data-library-action='archive']")) throw new Error("installed agent has export + archive");
    remove.click();
    await new Promise((r) => setTimeout(r, 400));
    if (!document.getElementById("characterLibraryModal").hidden) throw new Error("a clean deactivate closes the dialog");
    if (!document.getElementById("characterLibraryLive").textContent.includes("移除")) throw new Error("deactivate announced");
    await new Promise((r) => setTimeout(r, 200));
    if (banner.classList.contains("is-agent")) throw new Error("banner returns to the role after deactivate");
    if (!banner.querySelector(".session-role-banner-name").textContent.includes("Lily")) throw new Error("banner falls back to native Lily");
    return "deactivated";
  })()`);
  {
    const last = calls.filter((c) => c.channel === "agents:deactivate").at(-1)?.payload;
    check("deactivate-cas-payload", last?.sessionId === SESSION_ID && last?.expectedBindingVersion === 4, JSON.stringify(last));
  }

  // 6. Binding conflict → re-read getSession and retry once with the fresh version.
  agentsState.activateBehavior = "conflict-once";
  agentsState.conflicted = false;
  const activateCallsBefore = calls.filter((c) => c.channel === "agents:activate").length;
  await run("conflict-retry-once", `(async () => {
    const lib = await import("./modules/character-library.js");
    await lib.openCharacterLibrary({ tab: "agents" });
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector("[data-library-group='all']").click();
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector("#characterLibraryGrid [data-entity-id='agent_local'] [data-library-select]").click();
    await new Promise((r) => setTimeout(r, 150));
    const primary = document.querySelector("#characterLibraryDetail [data-library-activate]");
    if (primary.dataset.agentPrimary !== "use" || primary.textContent !== "应用到当前会话") throw new Error("installed agent primary: " + primary.textContent);
    primary.click();
    await new Promise((r) => setTimeout(r, 500));
    if (!document.getElementById("characterLibraryLive").textContent.includes("我的助理")) throw new Error("retry must succeed and announce");
    return "retried";
  })()`);
  {
    const attempts = calls.filter((c) => c.channel === "agents:activate").slice(activateCallsBefore).map((c) => c.payload);
    check("conflict-retry-payloads", attempts.length === 2 && attempts[0].expectedBindingVersion === 5 && attempts[1].expectedBindingVersion === 6 && attempts.every((p) => p.agentId === "agent_local"), JSON.stringify(attempts));
  }
  agentsState.activateBehavior = "ok";

  // 7. BUSY → busy notice, session unchanged.
  agentsState.activateBehavior = "busy";
  await run("busy-notice", `(async () => {
    const lib = await import("./modules/character-library.js");
    await lib.openCharacterLibrary({ tab: "agents" });
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector("[data-library-group='all']").click();
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector("#characterLibraryGrid [data-entity-id='agent_legal'] [data-library-select]").click();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector("#characterLibraryDetail [data-library-activate]").click();
    await new Promise((r) => setTimeout(r, 400));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("正在运行")) throw new Error("busy notice: " + notice.textContent);
    if (document.getElementById("characterLibraryModal").hidden) throw new Error("dialog stays open on BUSY");
    return notice.textContent;
  })()`);
  agentsState.activateBehavior = "ok";
  check("busy-leaves-binding", agentsState.binding.agentId === "agent_local", agentsState.binding.agentId);

  // 8. Distributed but not synced → pending notice, no activate call.
  const activateBeforePending = calls.filter((c) => c.channel === "agents:activate").length;
  await run("distributed-pending", `(async () => {
    document.querySelector("#characterLibraryGrid [data-entity-id='distributed:pkg_1'] [data-library-select]").click();
    await new Promise((r) => setTimeout(r, 150));
    const primary = document.querySelector("#characterLibraryDetail [data-library-activate]");
    if (primary.dataset.agentPrimary !== "pending") throw new Error("distributed not installed → pending");
    primary.click();
    await new Promise((r) => setTimeout(r, 200));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("尚未同步")) throw new Error("pending notice: " + notice.textContent);
    return "pending notice";
  })()`);
  check("distributed-no-activate", calls.filter((c) => c.channel === "agents:activate").length === activateBeforePending);

  // 9. Search + tag filter on the agents tab; then close.
  await run("agents-search-and-tag", `(async () => {
    const search = document.getElementById("characterLibrarySearch");
    const rows = () => [...document.querySelectorAll("#characterLibraryGrid [data-entity-id]")];
    search.value = "周报"; search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (rows().length !== 1 || !rows()[0].textContent.includes("周报助手")) throw new Error("search narrows to 周报助手, got " + rows().length);
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    const tag = document.getElementById("characterLibraryTagFilter");
    if (tag.hidden) throw new Error("tag filter must be available for agents");
    tag.value = "合同"; tag.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (rows().length !== 4) throw new Error("all fixtures carry the 合同 tag, got " + rows().length);
    tag.value = "无此标签"; tag.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    if (rows().length !== 0) throw new Error("tag filter excludes");
    tag.value = ""; tag.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("characterLibraryModal").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    return "filters work";
  })()`);

  // 10. "让 Lily 创建" for agents → prompt + marker kind "agent"; no manual form.
  await run("ai-create-agent-marker", `(async () => {
    const lib = await import("./modules/character-library.js");
    const marker = await import("./modules/character-authoring-marker.js");
    const input = document.getElementById("promptInput");
    input.value = "";
    await lib.openCharacterLibrary({ tab: "agents" });
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById("characterLibraryCreateBtn").click();
    await new Promise((r) => setTimeout(r, 100));
    if (!document.getElementById("characterLibraryModal").hidden) throw new Error("authoring returns to the conversation");
    if (!input.value.startsWith("帮我创建一个智能体")) throw new Error("agent prompt inserted: " + input.value.slice(0, 40));
    if (input.dataset.characterAuthoringKind !== "agent") throw new Error("marker kind must be agent, got " + input.dataset.characterAuthoringKind);
    const read = marker.readCharacterAuthoringMarker(input, input.value);
    if (read?.kind !== "agent") throw new Error("marker module must accept kind agent");
    if (marker.characterAuthoringOptions(read)?.characterAuthoringKind !== "agent") throw new Error("send options carry the agent kind");
    if (document.querySelector("#characterLibraryDetail [data-field='name']")) throw new Error("no manual agent form");
    marker.clearCharacterAuthoringMarker(input);
    input.value = "";
    return "kind=agent";
  })()`);

  // 11. Popover agent section: EVERY agent listed (8 official — 2 of them installed —
  // + 1 local installed + 1 distributed pending = 10 rows + the none row), ordered
  // active → installed → official → distributed; explainer; capability chips; role
  // heading note; switch with CAS; none row; manage button.
  for (let i = 3; i <= 8; i += 1) {
    agentsState.official.push({ id: `lily-extra-${i}`, version: 1, locale: "zh-CN", categoryId: "work-delivery", category: "工作与交付", editorialOrder: i, featured: i === 3, roleOfficialId: null, official: true, summary: summary(`官方助手${i}`, { icon: "", knowledge: { packs: [], guidance: "" }, tools: { mcpAllow: [], connectors: [], disallow: [] } }) });
  }
  await run("popover-agent-section-complete", `(async () => {
    const btn = document.getElementById("sessionRoleBanner");
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const popover = document.getElementById("characterPopover");
    if (popover.hidden) throw new Error("popover should open");
    if (!popover.querySelector(".character-popover-header span")?.textContent.includes("角色与智能体")) throw new Error("popover title renamed: " + popover.querySelector(".character-popover-header span")?.textContent);
    if (!btn.title.includes("智能体")) throw new Error("banner title mentions agents: " + btn.title);
    const section = document.getElementById("characterAgentSection");
    const explainer = section.querySelector("[data-agent-explainer]");
    if (!explainer || !explainer.textContent.includes("智能体 = 角色 + 技能 + 知识库 + 执行模式")) throw new Error("explainer under the heading: " + explainer?.textContent);
    if (section.querySelector(".character-agent-heading").nextElementSibling !== explainer) throw new Error("explainer sits directly under the heading");
    const rows = [...section.querySelectorAll("[data-agent-id], [data-agent-official-id], [data-agent-package-id]")];
    if (rows.length !== 10) throw new Error("all 10 agents listed (no 6 cap), got " + rows.length);
    if (section.querySelectorAll(".character-agent-list > .character-agent-option").length !== 11) throw new Error("10 agent rows + the none row");
    const ids = rows.map((r) => r.dataset.agentId || (r.dataset.agentOfficialId ? "official:" + r.dataset.agentOfficialId : "distributed:" + r.dataset.agentPackageId));
    if (ids[0] !== "agent_local") throw new Error("active first: " + ids.join(","));
    if (ids[1] !== "agent_weekly_report" || ids[2] !== "agent_legal") throw new Error("installed next, most recently used first: " + ids.join(","));
    if (ids[3] !== "official:lily-extra-3") throw new Error("official not installed follow, featured first: " + ids.join(","));
    if (ids.slice(3, 9).some((id) => !id.startsWith("official:"))) throw new Error("6 not-installed official rows in the middle: " + ids.join(","));
    if (ids[9] !== "distributed:pkg_1" || !rows[9].textContent.includes("入职向导")) throw new Error("distributed pending row is last: " + ids.join(","));
    rows[9].click();
    await new Promise((r) => setTimeout(r, 150));
    if (!section.querySelector(".character-agent-notice")?.textContent.includes("尚未同步")) throw new Error("pending distributed row explains instead of activating");
    const listStyle = getComputedStyle(section.querySelector(".character-agent-list"));
    if (listStyle.overflowY !== "auto" || !listStyle.maxHeight || listStyle.maxHeight === "none") throw new Error("long list scrolls inside the popover: " + listStyle.overflowY + " / " + listStyle.maxHeight);
    if (popover.getBoundingClientRect().height > 800) throw new Error("popover stays usable at ~800px: " + popover.getBoundingClientRect().height);
    const caps = (id) => rows.find((r) => r.dataset.agentId === id)?.querySelector("[data-agent-caps]")?.textContent || "";
    const legal = caps("agent_legal");
    if (!legal.includes("技能 2") || !legal.includes("知识 中国法律知识包") || !legal.includes("工具 1") || !legal.includes("确认后执行")) throw new Error("capability chips for 合同审查助手: " + legal);
    if (legal.includes("模型")) throw new Error("no empty model chip when presetId is empty: " + legal);
    const weekly = caps("agent_weekly_report");
    if (!weekly.includes("全自主") || !weekly.includes("模型 deepseek-v4-pro")) throw new Error("autonomy + model chips: " + weekly);
    if (caps("agent_local").includes("继承") || caps("agent_local").includes("自主")) throw new Error("inherited autonomy never shows a chip: " + caps("agent_local"));
    const extra = rows.find((r) => r.dataset.agentOfficialId === "lily-extra-4").querySelector("[data-agent-caps]")?.textContent || "";
    if (extra.includes("知识") || extra.includes("工具")) throw new Error("no chip for empty knowledge/tools: " + extra);
    const note = document.getElementById("characterList").querySelector("[data-role-agent-note]");
    if (!note || !note.textContent.includes("我的助理") || !note.textContent.includes("改选其他角色会停用该智能体")) throw new Error("role heading note names the active agent: " + note?.textContent);
    if (!popover.querySelector("[data-character-mode='native']") || popover.querySelector("[data-character-mode='native']").disabled) throw new Error("role rows stay clickable");
    popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    return "rows=" + rows.length;
  })()`);
  await run("popover-agent-section", `(async () => {
    const btn = document.getElementById("sessionRoleBanner");
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const popover = document.getElementById("characterPopover");
    if (popover.hidden) throw new Error("popover should open");
    const section = document.getElementById("characterAgentSection");
    if (section.hidden) throw new Error("agent section must be visible when agents exist");
    if (section !== document.getElementById("characterPopoverMain").firstElementChild) throw new Error("agent section sits at the top of the popover");
    if (!section.querySelector(".character-agent-heading")?.textContent.includes("智能体")) throw new Error("section heading");
    const none = section.querySelector("[data-agent-mode='none']");
    if (!none || !none.textContent.includes("原生 Lily")) throw new Error("none row missing");
    const rows = [...section.querySelectorAll("[data-agent-id], [data-agent-official-id], [data-agent-package-id]")];
    if (rows.length !== 10) throw new Error("expected all 10 agent rows, got " + rows.length);
    const active = rows.find((r) => r.getAttribute("aria-checked") === "true");
    if (active?.dataset.agentId !== "agent_local") throw new Error("active agent row is checked: " + active?.dataset.agentId);
    if (rows[0] !== active) throw new Error("installed/active agents list first");
    if (!rows.some((r) => r.dataset.agentOfficialId === "lily-weekly-report" || r.dataset.agentId === "agent_weekly_report")) throw new Error("featured official listed");
    if (!section.querySelector("[data-agent-manage]")?.textContent.includes("管理智能体库")) throw new Error("manage button");
    // Role rows keep working alongside.
    if (!popover.querySelector("[data-character-mode='native']")) throw new Error("role native row must remain");
    rows.find((r) => r.dataset.agentId === "agent_legal").click();
    await new Promise((r) => setTimeout(r, 500));
    if (!popover.hidden) throw new Error("a successful switch closes the popover");
    if (btn.querySelector(".session-role-banner-name").textContent !== "合同审查助手") throw new Error("banner shows the switched agent");
    return "switched";
  })()`);
  {
    const last = calls.filter((c) => c.channel === "agents:activate").at(-1)?.payload;
    check("popover-switch-cas", last?.agentId === "agent_legal" && last?.sessionId === SESSION_ID && Number.isInteger(last?.expectedBindingVersion) && last.expectedBindingVersion === agentsState.binding.bindingVersion - 1, JSON.stringify(last));
  }
  await run("popover-none-and-manage", `(async () => {
    const btn = document.getElementById("sessionRoleBanner");
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const section = document.getElementById("characterAgentSection");
    section.querySelector("[data-agent-mode='none']").click();
    await new Promise((r) => setTimeout(r, 500));
    if (btn.classList.contains("is-agent")) throw new Error("none row removes the agent");
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    if (document.getElementById("characterAgentSection").querySelector("[data-agent-mode='none']").getAttribute("aria-checked") !== "true") throw new Error("none row checked when no agent");
    document.getElementById("characterAgentSection").querySelector("[data-agent-manage]").click();
    await new Promise((r) => setTimeout(r, 300));
    const modal = document.getElementById("characterLibraryModal");
    if (modal.hidden) throw new Error("manage opens the library");
    if (document.querySelector("#characterLibraryTabs [data-library-tab='agents']").getAttribute("aria-selected") !== "true") throw new Error("manage opens on the agents tab");
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    return "none + manage";
  })()`);
  {
    const last = calls.filter((c) => c.channel === "agents:deactivate").at(-1)?.payload;
    check("popover-none-cas", Number.isInteger(last?.expectedBindingVersion) && last.expectedBindingVersion === agentsState.binding.bindingVersion - 1, JSON.stringify(last));
  }

  // 11b. A role pick while an agent is bound: main returns `agentDeactivated` →
  // announcement names both, the agent section reloads, the banner drops the agent.
  agentsState.binding = { ...agentsState.binding, bindingVersion: agentsState.binding.bindingVersion + 1, agentId: "agent_legal", agentRevisionId: "rev_o1", displayName: "合同审查助手" };
  const getSessionBefore = calls.filter((c) => c.channel === "agents:get-session").length;
  await run("role-pick-deactivates-agent", `(async () => {
    const btn = document.getElementById("sessionRoleBanner");
    window.dispatchEvent(new CustomEvent("lily:agent-binding-changed", { detail: { sessionId: "${SESSION_ID}" } }));
    await new Promise((r) => setTimeout(r, 300));
    if (!btn.classList.contains("is-agent") || btn.querySelector(".session-role-banner-name").textContent !== "合同审查助手") throw new Error("precondition: agent bound on the banner");
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const note = document.getElementById("characterList").querySelector("[data-role-agent-note]");
    if (!note || !note.textContent.includes("合同审查助手")) throw new Error("role note names the bound agent: " + note?.textContent);
    document.getElementById("characterList").querySelector("[data-character-mode='native']").click();
    await new Promise((r) => setTimeout(r, 600));
    const live = document.getElementById("characterControlLive").textContent;
    if (!live.includes("已改选角色「Lily 原声」") || !live.includes("智能体「合同审查助手」已停用")) throw new Error("announcement names role + agent: " + live);
    if (!document.getElementById("characterPopover").hidden) throw new Error("a successful role pick closes the popover");
    if (btn.classList.contains("is-agent") || btn.dataset.agentId) throw new Error("banner un-decorated after the agent was released");
    if (!btn.querySelector(".session-role-banner-name").textContent.includes("Lily")) throw new Error("banner falls back to the role: " + btn.querySelector(".session-role-banner-name").textContent);
    const control = await import("./modules/character-session-control.js");
    if (control.getAgentSessionSectionState().session?.active) throw new Error("agent section reloaded to no agent");
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    if (document.getElementById("characterList").querySelector("[data-role-agent-note]")) throw new Error("role note disappears once no agent is bound");
    if (document.getElementById("characterAgentSection").querySelector("[data-agent-mode='none']").getAttribute("aria-checked") !== "true") throw new Error("none row checked after release");
    document.getElementById("characterPopover").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    return live;
  })()`);
  {
    const setBinding = calls.filter((c) => c.channel === "session-character:set-binding").at(-1)?.payload;
    check("role-pick-set-binding-payload", setBinding?.sessionId === SESSION_ID && setBinding?.mode === "native", JSON.stringify(setBinding));
    check("role-pick-reloads-agent-section", calls.filter((c) => c.channel === "agents:get-session").length > getSessionBefore + 1, `get-session calls before=${getSessionBefore}`);
    check("role-pick-cleared-binding", agentsState.binding.agentId === null, String(agentsState.binding.agentId));
  }

  // 11c. In-conversation traces: the agentBinding platform card (live runtime event
  // → committed message) and the "由智能体「X」回答" label (only with meta.agent).
  await run("agent-binding-platform-card", `(async () => {
    const store = await import("./modules/session-runtime-store.js");
    const message = await import("./modules/message.js");
    const sid = "${SESSION_ID}";
    const committedMessage = {
      id: "msg_agent_binding_1", role: "assistant", turnId: null, timestamp: new Date().toISOString(),
      content: "已启用智能体「合同审查助手」\\n- 角色：法务顾问\\n- 技能：lily-doc-review、lily-web-search\\n- 知识库：中国法律知识包\\n- 执行模式：确认后执行",
      meta: { agentBinding: { kind: "activated", agentId: "agent_legal", name: "合同审查助手", icon: "🧭", bindingVersion: 9, dimensions: ["role", "skills", "knowledge", "autonomy"], degraded: [], skills: ["lily-doc-review", "lily-web-search"], knowledgePacks: ["中国法律知识包"], autonomy: "ask", model: "", tools: [], roleName: "法务顾问", keepsEngine: true } },
    };
    store.applyRuntimeBatch({ sessionId: sid, batchSeq: 9001, events: [{
      id: "evt_agent_binding_1", type: "engine.notice", source: "agent_binding", sessionId: sid, turnId: null, seq: 9001, ts: Date.now(),
      payload: { notice: { code: "agentBindingChanged", level: "info", panel: false }, committedMessage },
    }] });
    const runtime = store.getRuntimeSession(sid);
    if (!runtime.committedMessages.some((m) => m.id === "msg_agent_binding_1")) throw new Error("committed message upserted from the runtime event");
    if (runtime.attention === "failed") throw new Error("an agent binding notice must not mark the session failed");
    message.renderConversation(sid);
    await new Promise((r) => setTimeout(r, 250));
    const card = document.querySelector(".agent-binding-notice");
    if (!card) throw new Error("platform card rendered");
    if (!card.classList.contains("is-activated") || card.dataset.agentBindingKind !== "activated") throw new Error("kind class: " + card.className);
    if (card.classList.contains("assistant-turn-article")) throw new Error("card is not an assistant bubble");
    if (card.querySelector(".agent-binding-notice-avatar")?.textContent !== "🧭") throw new Error("agent icon on the card");
    if (!card.querySelector(".agent-binding-notice-title")?.textContent.includes("已启用智能体「合同审查助手」")) throw new Error("title line: " + card.querySelector(".agent-binding-notice-title")?.textContent);
    const lines = [...card.querySelectorAll(".agent-binding-notice-lines li")].map((li) => li.textContent);
    if (lines.length !== 4 || !lines[0].startsWith("角色：") || lines[0].startsWith("- ")) throw new Error("bullet lines without markers: " + JSON.stringify(lines));
    if (card.querySelector(".assistant-turn-footer") || card.querySelector("[data-action='retry']")) throw new Error("no assistant chrome on a platform card");
    return "card ok";
  })()`);
  await run("answered-by-agent-label", `(async () => {
    const store = await import("./modules/session-runtime-store.js");
    const message = await import("./modules/message.js");
    const sid = "${SESSION_ID}";
    const ts = new Date().toISOString();
    const runtime = store.getRuntimeSession(sid);
    store.syncCommittedMessages(sid, [
      ...runtime.committedMessages,
      { id: "msg_by_agent", role: "assistant", turnId: "turn_by_agent", timestamp: ts, content: "合同第 3 条存在违约金过高风险。", record: { turnId: "turn_by_agent", assistantText: "合同第 3 条存在违约金过高风险。", meta: { agent: { id: "agent_legal", name: "合同审查助手", icon: "🧭" } } } },
      { id: "msg_plain", role: "assistant", turnId: "turn_plain", timestamp: ts, content: "这是原生 Lily 的普通回答。", record: { turnId: "turn_plain", assistantText: "这是原生 Lily 的普通回答。", meta: {} } },
      { id: "msg_legacy_agent", role: "assistant", turnId: "turn_legacy_agent", timestamp: ts, content: "旧路径：meta.agent 在消息层。", meta: { agent: { id: "agent_local", name: "我的助理" } } },
    ]);
    message.renderConversation(sid);
    await new Promise((r) => setTimeout(r, 300));
    const byAgent = document.querySelector(".assistant-turn-article[data-turn-id='turn_by_agent']");
    if (!byAgent) throw new Error("agent-answered article rendered");
    const label = byAgent.querySelector(".assistant-turn-agent-label");
    if (!label || label.textContent !== "🧭由智能体「合同审查助手」回答") throw new Error("label text + icon: " + label?.textContent);
    if (!byAgent.querySelector(".assistant-turn-speaker")?.contains(label)) throw new Error("label rides in the speaker row");
    if (byAgent.dataset.answeredByAgent !== "agent_legal") throw new Error("article marks the answering agent");
    const plain = document.querySelector(".assistant-turn-article[data-turn-id='turn_plain']");
    if (!plain) throw new Error("plain article rendered");
    if (plain.querySelector(".assistant-turn-agent-label") || plain.dataset.answeredByAgent) throw new Error("no label without meta.agent");
    const legacy = document.querySelector(".assistant-turn-article[data-turn-id='turn_legacy_agent']");
    const legacyLabel = legacy?.querySelector(".assistant-turn-agent-label");
    if (!legacyLabel || !legacyLabel.textContent.includes("我的助理") || legacyLabel.querySelector(".assistant-turn-agent-glyph")?.textContent !== "我") throw new Error("legacy meta.agent path with monogram: " + legacyLabel?.textContent);
    if (document.querySelectorAll(".assistant-turn-agent-label").length !== 2) throw new Error("exactly two labelled articles");
    store.syncCommittedMessages(sid, []);
    message.renderConversation(sid, { force: true });
    return "label ok";
  })()`);

  // 12. Starters: only for an empty conversation with an agent bound.
  agentsState.binding = { ...agentsState.binding, bindingVersion: agentsState.binding.bindingVersion + 1, agentId: "agent_legal", agentRevisionId: "rev_o1", displayName: "合同审查助手" };
  await run("starters-empty-conversation", `(async () => {
    const store = (await import("./modules/state.js")).default;
    const starters = await import("./modules/agent-starters.js");
    starters.resetAgentStartersCache();
    window.dispatchEvent(new CustomEvent("lily:agent-binding-changed", { detail: { sessionId: store.get("activeSessionId") } }));
    await new Promise((r) => setTimeout(r, 300));
    const bar = document.getElementById("agentStarters");
    if (bar.hidden) throw new Error("starters should render for an empty conversation with an agent bound");
    const chips = [...bar.querySelectorAll("[data-agent-starter]")];
    if (chips.length !== 3) throw new Error("3 starter chips, got " + chips.length);
    if (bar.compareDocumentPosition(document.getElementById("promptInput")) & Node.DOCUMENT_POSITION_FOLLOWING === 0) throw new Error("starters sit above the composer");
    chips[1].click();
    const input = document.getElementById("promptInput");
    if (input.value !== "总结主要风险") throw new Error("chip fills the composer: " + input.value);
    if (document.activeElement !== input) throw new Error("chip focuses the composer");
    input.value = "";
    store.set("conversation", [{ role: "user", content: "hi" }]);
    await new Promise((r) => setTimeout(r, 100));
    if (!bar.hidden) throw new Error("starters hide once the conversation has a message");
    store.set("conversation", []);
    await new Promise((r) => setTimeout(r, 200));
    if (bar.hidden) throw new Error("starters return for an empty conversation");
    return "chips=" + chips.length;
  })()`);
  agentsState.binding = { ...agentsState.binding, bindingVersion: agentsState.binding.bindingVersion + 1, agentId: null, agentRevisionId: null, displayName: "" };
  await run("starters-hidden-no-agent", `(async () => {
    const store = (await import("./modules/state.js")).default;
    window.dispatchEvent(new CustomEvent("lily:agent-binding-changed", { detail: { sessionId: store.get("activeSessionId") } }));
    await new Promise((r) => setTimeout(r, 300));
    if (!document.getElementById("agentStarters").hidden) throw new Error("no agent → no starters");
    return "hidden";
  })()`);

  // 13. Sidebar: a session carrying `agent` shows the icon mark.
  await run("sidebar-agent-mark", `(async () => {
    const tree = await import("./modules/project-tree.js");
    tree.renderProjectTree();
    await new Promise((r) => setTimeout(r, 50));
    const item = document.querySelector(".session-item[data-session-id='session_with_agent']");
    if (!item) throw new Error("session row missing");
    const mark = item.querySelector(".session-agent-mark");
    if (!mark || mark.textContent !== "🧭") throw new Error("agent mark with icon expected");
    if (!mark.title.includes("合同审查助手")) throw new Error("mark title names the agent");
    if (item.querySelector(".session-title").textContent !== "Contract review") throw new Error("title text stays clean for search");
    if (document.querySelector(".session-item[data-session-id='session_alpha_recent'] .session-agent-mark")) throw new Error("sessions without agent have no mark");
    return "mark ok";
  })()`);

  // 14. Kill switch: list → {ok:true, disabled:true} shows a localized notice; popover section hides.
  agentsState.listBehavior = "disabled";
  await run("kill-switch-notice", `(async () => {
    const lib = await import("./modules/character-library.js");
    await lib.openCharacterLibrary();
    await new Promise((r) => setTimeout(r, 300));
    const notice = document.getElementById("characterLibraryNotice");
    if (notice.hidden || !notice.textContent.includes("已关闭")) throw new Error("kill switch notice: " + notice.textContent);
    if (document.querySelectorAll("#characterLibraryGrid [data-entity-id]").length !== 0) throw new Error("disabled → no rows");
    if (!document.getElementById("characterLibraryGrid").textContent.includes("还没有智能体")) throw new Error("localized empty state");
    document.getElementById("characterLibraryModal").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    document.getElementById("sessionRoleBanner").click();
    await new Promise((r) => setTimeout(r, 400));
    if (!document.getElementById("characterAgentSection").hidden) throw new Error("popover agent section hides under the kill switch");
    if (document.getElementById("characterPopover").querySelector("[data-character-mode='native']") == null) throw new Error("role control keeps working");
    document.getElementById("characterPopover").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return "disabled handled";
  })()`);
  agentsState.listBehavior = "ok";

  // 15. Characters tab still works (no role regression inside the dialog).
  await run("characters-tab-intact", `(async () => {
    const lib = await import("./modules/character-library.js");
    await lib.openCharacterLibrary({ tab: "characters" });
    await new Promise((r) => setTimeout(r, 300));
    if (document.querySelector("#characterLibraryTabs [data-library-tab='characters']").getAttribute("aria-selected") !== "true") throw new Error("characters tab selectable");
    if (document.getElementById("characterLibrarySourceFilter").hidden) throw new Error("source filter returns on characters tab");
    if (document.getElementById("characterLibraryImportBtn").textContent !== "导入角色卡") throw new Error("import label restored");
    document.querySelector("#characterLibraryTabs [data-library-tab='agents']").click();
    await new Promise((r) => setTimeout(r, 300));
    if (document.querySelectorAll("#characterLibraryGrid [data-entity-id]").length === 0) throw new Error("switching back reloads agents");
    document.getElementById("characterLibraryModal").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return "both tabs";
  })()`);

  finish(app.exitCode || 0);
}).catch((error) => {
  console.error("test-agent-library-ui: harness error", error);
  finish(1);
});
