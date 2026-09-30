#!/usr/bin/env node
"use strict";

/**
 * Account · Usage · License settings pages rendered in a real renderer with
 * fixture IPC. Asserts the layout invariants that went wrong once (an unstyled
 * card, an empty state shouting zeros, warning color on routine status) and
 * optionally writes screenshots for eyeballing:
 *   ACCOUNT_PAGES_CAPTURE_DIR=/tmp/x npx electron scripts/test-account-pages-visual.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error("test-account-pages-visual must run under Electron: npx electron scripts/test-account-pages-visual.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
const captureDir = String(process.env.ACCOUNT_PAGES_CAPTURE_DIR || "").trim()
  ? path.resolve(process.env.ACCOUNT_PAGES_CAPTURE_DIR)
  : "";

// The usage page reads { limits, extraCredits, … } from main (usage-limits.js).
const limitsFixture = (extra = {}) => ({ ok: true, signedIn: true, identity: "personal", limits: [], extraCredits: 0, hasPlan: false, images: 0, videos: 0, ...extra });

const fixtures = {
  account: {
    loggedIn: true,
    user: { phoneE164: "+8613800001234" },
    entitlements: { tokenBalance: 0, imageGenerationsRemaining: 0, videoGenerationsRemaining: 0, membershipExpiresAt: null },
  },
  organizations: [{ id: "org_1", name: "示例科技有限公司" }],
  license: { activated: true, valid: true, license: { customer: "示例科技", plan: "team", expiresAt: "2027-01-01T00:00:00.000Z" } },
  limits: limitsFixture(),
  policy: { region: "china", features: { account: true, usage: true } },
  searchProvider: "iqs",
  memoryCalls: [],
};

const MEMORY_BY_PROJECT = {
  ws_a: [{ key: "a1", text: "回复用中文，代码注释用英文。", createdAt: "2026-09-01" }],
  ws_b: [{ key: "b1", text: "周报固定用三段式。", createdAt: "2026-09-10" }, { key: "b2", text: "数据表默认导出为 xlsx。", createdAt: "2026-09-12" }],
};

function registerFixtureIpc() {
  const handle = (channel, fn) => {
    try { ipcMain.handle(channel, fn); } catch { /* reused Electron run */ }
  };
  const ok = (extra = {}) => () => ({ ok: true, ...extra });
  handle("notifications:get", ok({ notifications: [] }));
  handle("app:get-locale", ok({ locale: "zh-CN" }));
  handle("app:get-version", ok({ version: "0.0.0-test" }));
  handle("app:get-edition", ok({ id: "domestic", features: {} }));
  handle("app:get-icon-url", ok({ url: "" }));
  handle("assistant:feature-flags", ok({ flags: {} }));
  handle("app:get-policy", () => ({ ok: true, ...fixtures.policy }));
  handle("media-providers:list", ok({ providers: [] }));
  handle("web-credentials:list", ok({ credentials: [] }));
  handle("session:get-skills", ok({ skills: [] }));
  handle("session:get-permission", ok({ permission: "default" }));
  handle("updates:get-state", ok({ state: { phase: "idle" } }));
  handle("updates:get-settings", ok({ settings: { autoCheck: true } }));
  handle("state:full", ok({ state: {} }));
  handle("workspace-apps:list", ok({ apps: [] }));
  handle("runtime-packs:list", ok({ packs: [] }));
  handle("runtime-packs:location", ok({ locations: [] }));
  handle("mail-accounts:list", ok({ accounts: [] }));
  handle("mobile-pairing:poll-pending", ok({ grants: [] }));
  handle("mobile-pairing:status", ok({ bridged: false }));
  handle("models:list", ok({ presets: [], activePresetId: "" }));
  handle("permissions:list", ok({ modes: [], currentMode: "" }));
  handle("search:list", () => ({ ok: true, providers: [{ id: "iqs", name: "阿里 IQS" }, { id: "searxng", name: "SearXNG" }], providerId: fixtures.searchProvider, searxngUrl: "" }));
  handle("search:set-provider", (_event, providerId) => { fixtures.searchProvider = providerId; return { ok: true }; });
  handle("skills:list", ok({ groups: [], skills: [] }));
  handle("skills:get-preset-guide", ok({ guide: null }));
  handle("skills:check-updates", ok({ updates: [] }));
  handle("apps:catalog", ok({ json: { apps: [] } }));
  handle("assistant:memory:list", (_event, payload) => {
    fixtures.memoryCalls.push({ sessionId: payload?.sessionId ?? null, projectId: payload?.projectId ?? null });
    const projectId = payload?.projectId || "ws_a";
    return { ok: true, sessionId: payload?.sessionId ?? null, projectId, learned: MEMORY_BY_PROJECT[projectId] || [], proposals: [],
      preferences: { schemaVersion: 1, disabledKinds: [] }, categories: ["learned_conventions", "project_memory"] };
  });
  handle("agents:list", ok({ agents: [] }));
  handle("agents:get-session", ok({ agent: null }));

  handle("account:status", () => ({ ok: true, ...fixtures.account }));
  handle("account:organizations", () => ({ ok: true, organizations: fixtures.organizations }));
  handle("account:current-organization", () => ({ ok: true, organizationId: "" }));
  handle("license:status", () => ({ ok: true, ...fixtures.license }));
  handle("usage:limits", () => fixtures.limits);
}

let win = null;

function execute(source) {
  return win.webContents.executeJavaScript(`(async () => { ${source} })()`, true);
}

async function settle(ms = 350) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await execute("await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));");
}

async function openPage(pageId) {
  await execute(`
    const { openSettingsPage } = await import("./modules/settings-panel.js");
    openSettingsPage(${JSON.stringify(pageId)});
  `);
  await settle(600);
}

async function capture(name) {
  if (!captureDir) return;
  fs.mkdirSync(captureDir, { recursive: true });
  const image = await win.webContents.capturePage();
  if (image.isEmpty()) throw new Error(`capture ${name} is empty`);
  fs.writeFileSync(path.join(captureDir, `${name}.png`), image.toPNG());
}

async function main() {
  registerFixtureIpc();
  win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1500,
    backgroundColor: "#f4f6f8",
    webPreferences: { preload: path.join(root, "src/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await win.webContents.executeJavaScript(`localStorage.setItem("lily.themeMode", "light"); location.reload();`);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const q = (source) => execute(`return (() => { ${source} })();`);
  const probeColor = (variable) => q(`
    const el = document.createElement("span"); el.style.color = "var(${variable})"; document.body.append(el);
    const color = getComputedStyle(el).color; el.remove(); return color;
  `);

  // One section title across the three pages; the first sub-tab names the
  // overview rather than repeating the section.
  const headings = await q(`return [...document.querySelectorAll("[data-account-section-title]")].map((el) => el.textContent.trim());`);
  assert.deepEqual(headings, ["账户", "账户", "账户"]);
  const firstTabs = await q(`return [...document.querySelectorAll('.settings-subnav-tab[data-settings-link="account"]')].map((el) => el.textContent.trim());`);
  assert.deepEqual(firstTabs, ["概览", "概览", "概览"]);

  await openPage("account");
  await capture("account-signed-in");
  const signedIn = await q(`
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      modesDisplay: cs("#accountLoginModes").display,
      headDisplay: cs("#accountLoginForm .account-card-head").display,
      statusHidden: document.getElementById("accountStatusText").hidden,
      identity: document.getElementById("accountSignedInPhone").textContent.trim(),
      loggedInMentions: (document.getElementById("settingsPageAccount").innerText.match(/账户已登录/g) || []).length,
      billingWidth: document.getElementById("accountBillingBtn").getBoundingClientRect().width,
    };
  `);
  assert.equal(signedIn.modesDisplay, "none", "login-mode toggle must hide once signed in");
  assert.equal(signedIn.headDisplay, "none", "card head gives way to the identity panel once signed in");
  assert.equal(signedIn.statusHidden, true, "header status line is redundant while signed in");
  assert.equal(signedIn.identity, "+8613800001234", "identity panel shows who is signed in");
  assert.equal(signedIn.loggedInMentions, 0, "\"账户已登录\" no longer repeats across the page");
  assert(signedIn.billingWidth < 260, `billing button must not stretch, got ${signedIn.billingWidth}px`);

  const footerPhone = await q(`return { name: document.getElementById("accountMenuName").textContent, sub: document.getElementById("accountMenuSub").textContent };`);
  assert.deepEqual(footerPhone, { name: "138****1234", sub: "个人账户" }, "phone account without membership: masked phone + account kind");

  await openPage("usage");
  await capture("usage");
  const usage = await q(`
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
    const org = document.getElementById("accountOrgSelectCard");
    return {
      orgPaddingTop: parseFloat(getComputedStyle(org).paddingTop),
      orgTitleLeft: rect("#accountOrgSelectCard h4").left,
      usageTitleLeft: rect("#usageLimitsSection h4").left,
      orgSelectWidth: rect("#accountOrgSelect").width,
      cards: document.querySelectorAll("#settingsPageUsage .account-settings-card").length,
      refreshButtons: document.querySelectorAll("#accountRefreshBtn, #usageRefresh").length,
      refreshLabel: document.getElementById("usageRefresh").textContent.trim(),
      bars: document.querySelectorAll(".usage-limit-bar").length,
      credits: document.querySelector(".usage-credits-value")?.textContent.trim(),
      hint: document.querySelector(".usage-credits-hint")?.textContent || "",
      buy: document.querySelectorAll(".usage-credits-buy").length,
      statementHidden: document.getElementById("usageStatementLink").hidden,
      text: document.getElementById("settingsPageUsage").innerText,
    };
  `);
  assert(usage.orgPaddingTop >= 16, `organization section needs breathing room, got ${usage.orgPaddingTop}px`);
  assert.equal(Math.round(usage.orgTitleLeft), Math.round(usage.usageTitleLeft), "section titles share one left edge");
  assert(usage.orgSelectWidth <= 440, `organization select must not span the page, got ${usage.orgSelectWidth}px`);
  assert.equal(usage.cards, 0, "usage page carries no nested cards");
  assert.equal(usage.refreshButtons, 1, "exactly one refresh control on the page");
  assert.equal(usage.refreshLabel, "刷新");
  assert.equal(usage.bars, 0, "no plan, no bar");
  assert.equal(usage.credits, "0", "extra credits show as a plain balance");
  assert.match(usage.hint, /按各模型的价格扣除积分/);
  assert.equal(usage.buy, 1, "phone account with purchase enabled can top up");
  assert.equal(usage.statementHidden, false, "the charge-by-charge record is one click away");
  assert.doesNotMatch(usage.text, /[¥￥]|Token|预估/, "no money, token tables or estimates on the usage page");

  fixtures.limits = limitsFixture({
    limits: [
      { kind: "plan", tier: "max", unlimited: false, percent: 42, resetsAt: "2026-10-02T02:00:00.000Z" },
      { kind: "license", tier: "unlimited", unlimited: true, percent: null, resetsAt: "2026-10-03T00:00:00.000Z" },
    ],
    extraCredits: 12340, hasPlan: true, images: 40, videos: 0,
  });
  await openPage("usage");
  await capture("usage-with-plan");
  const plan = await q(`
    const rows = [...document.querySelectorAll(".usage-limit")];
    return {
      rows: rows.length,
      labels: rows.map((row) => row.querySelector(".usage-limit-label").textContent),
      values: rows.map((row) => row.querySelector(".usage-limit-value").textContent),
      bars: [...document.querySelectorAll(".usage-limit-bar")].map((bar) => bar.value),
      reset: rows[0].querySelector(".usage-limit-meta")?.textContent || "",
      credits: document.querySelector(".usage-credits-value").textContent.trim(),
      hint: document.querySelector(".usage-credits-hint").textContent,
      lines: [...document.querySelectorAll(".usage-credits-line")].map((line) => line.textContent),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  `);
  assert.equal(plan.rows, 2);
  assert.deepEqual(plan.labels, ["Lily Max 套餐", "授权码"]);
  assert.deepEqual(plan.values, ["已用 42%", "不限量"]);
  assert.deepEqual(plan.bars, [42], "an unlimited allowance draws no bar");
  assert.match(plan.reset, /重置$/, "the reset time is shown");
  assert.equal(plan.credits, "12,340");
  assert.match(plan.hint, /套餐本周额度用完后/);
  assert.deepEqual(plan.lines, ["图片生成剩余 40 次"], "only generations that exist are listed");
  assert(plan.overflow <= 1, "no horizontal overflow");

  await openPage("license");
  await capture("license-valid");
  const licenseValid = await q(`
    return {
      status: document.getElementById("licenseStatusText").textContent,
      clearHidden: document.getElementById("licenseClearBtn").hidden,
      activatePrimary: document.getElementById("licenseActivateBtn").classList.contains("settings-action-btn--primary"),
      clearDanger: document.getElementById("licenseClearBtn").classList.contains("settings-action-btn--danger"),
      labelled: Boolean(document.querySelector("label.license-token-field #licenseTokenInput")),
    };
  `);
  assert.match(licenseValid.status, /2027年1月1日/, "expiry follows the UI locale, not US month/day/year");
  assert.equal(licenseValid.clearHidden, false);
  assert.equal(licenseValid.activatePrimary, true);
  assert.equal(licenseValid.clearDanger, true);
  assert.equal(licenseValid.labelled, true);

  // Enterprise edition: password login only, no purchase; the identity line is
  // the login name and the nickname row keeps its field and button on one line.
  fixtures.policy = { region: "china", features: { account: true, accountLogin: false, enterpriseAccountLogin: true, billing: false, usage: true } };
  fixtures.account = { loggedIn: true, user: { id: "u_1", loginName: "zhangqin", displayName: "张钦" }, entitlements: { tokenBalance: 0, imageGenerationsRemaining: 0, videoGenerationsRemaining: 0, membershipExpiresAt: null } };
  await openPage("account");
  await capture("account-enterprise");
  const enterprise = await q(`
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      identity: document.getElementById("accountSignedInPhone").textContent.trim(),
      modesDisplay: cs("#accountLoginModes").display,
      billingHidden: document.getElementById("accountBillingBtn").hidden,
      logoutWidth: rect("#accountLogoutBtn").width,
      nicknameHidden: document.getElementById("accountNicknamePanel").hidden,
      nicknameValue: document.getElementById("accountNicknameInput").value,
      sameRow: Math.abs(rect("#accountNicknameInput").top - rect("#accountNicknameSaveBtn").top) < 2,
      loggedInMentions: (document.getElementById("settingsPageAccount").innerText.match(/账户已登录|已登录：/g) || []).length,
    };
  `);
  assert.equal(enterprise.identity, "zhangqin");
  assert.equal(enterprise.modesDisplay, "none", "single-mode toggle must not linger once signed in");
  assert.equal(enterprise.billingHidden, true);
  assert(enterprise.logoutWidth < 200, `logout must not stretch across the card, got ${enterprise.logoutWidth}px`);
  assert.equal(enterprise.nicknameHidden, false);
  assert.equal(enterprise.nicknameValue, "张钦");
  assert.equal(enterprise.sameRow, true, "nickname input and save button share one row");
  assert.equal(enterprise.loggedInMentions, 0);
  fixtures.limits = limitsFixture();
  await openPage("usage");
  const enterpriseUsage = await q(`return {
    buy: document.querySelectorAll(".usage-credits-buy").length,
    statementHidden: document.getElementById("usageStatementLink").hidden,
  };`);
  assert.equal(enterpriseUsage.buy, 0, "no self-serve top-up when the edition disables billing");
  assert.equal(enterpriseUsage.statementHidden, true, "nor a website statement link");
  await openPage("account");
  const footerEnterprise = await q(`return { name: document.getElementById("accountMenuName").textContent, sub: document.getElementById("accountMenuSub").textContent, mono: document.querySelector("#accountMenuAvatar .account-avatar-monogram")?.textContent || "" };`);
  assert.deepEqual(footerEnterprise, { name: "张钦", sub: "zhangqin", mono: "张" }, "sidebar footer names the person, never \"已登录\" twice");

  fixtures.policy = { region: "china", features: { account: true, usage: true } };
  fixtures.account = { loggedIn: false };
  fixtures.license = { activated: false };
  await openPage("account");
  await capture("account-signed-out");
  const signedOut = await q(`
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      statusHidden: document.getElementById("accountStatusText").hidden,
      statusText: document.getElementById("accountStatusText").textContent,
      modesDisplay: cs("#accountLoginModes").display,
      headDisplay: cs("#accountLoginForm .account-card-head").display,
    };
  `);
  assert.equal(signedOut.statusHidden, false);
  assert.match(signedOut.statusText, /未登录/);
  assert.notEqual(signedOut.modesDisplay, "none");
  assert.notEqual(signedOut.headDisplay, "none");

  fixtures.limits = limitsFixture({ signedIn: false, extraCredits: null });
  await openPage("usage");
  const usageOut = await q(`return { text: document.getElementById("usageLimitsSection").textContent,
    credits: document.querySelectorAll(".usage-credits").length, statementHidden: document.getElementById("usageStatementLink").hidden };`);
  assert.match(usageOut.text, /登录账户后/, "signed out: one sentence with the way in");
  assert.equal(usageOut.credits, 0, "no balance while signed out");
  assert.equal(usageOut.statementHidden, true);

  await openPage("license");
  await capture("license-inactive");

  // Memory is per workspace and the page says so: a workspace picker leads,
  // switching it re-reads that workspace's memory, a workspace's context menu
  // lands here pre-selected, and the nav files the page under "工作区".
  await execute(`
    const store = (await import("./modules/state.js")).default;
    store.set("projects", [
      { id: "ws_a", name: "learnenglish", path: "/tmp/ws-a", sessions: [{ id: "s_a", title: "新对话", updatedAt: new Date().toISOString() }] },
      { id: "ws_b", name: "2026-ai-platform", path: "/tmp/ws-b", sessions: [{ id: "s_b", title: "新对话", updatedAt: new Date().toISOString() }] },
    ]);
    store.set("activeProjectId", "ws_a");
    store.set("activeSessionId", "s_a");
  `);
  fixtures.memoryCalls.length = 0;
  await openPage("memory");
  const memoryA = await q(`
    const select = document.getElementById("memoryWorkspaceSelect");
    const nav = [...document.querySelectorAll(".settings-nav > *")];
    const groupIndex = nav.findIndex((el) => el.classList.contains("settings-nav-group") && el.textContent.trim() === "工作区");
    const memoryIndex = nav.findIndex((el) => el.dataset.settingsPage === "memory");
    return {
      options: [...select.options].map((o) => o.textContent),
      selected: select.value,
      learned: [...document.querySelectorAll("#memoryLearnedList .settings-memory-text")].map((el) => el.textContent),
      navGrouped: groupIndex >= 0 && memoryIndex === groupIndex + 1,
      desc: document.querySelector("#settingsPageMemory .settings-section-desc").textContent,
    };
  `);
  assert.deepEqual(memoryA.options, ["learnenglish", "2026-ai-platform"]);
  assert.equal(memoryA.selected, "ws_a", "picker follows the active workspace by default");
  assert.deepEqual(memoryA.learned, ["回复用中文，代码注释用英文。"]);
  assert.equal(memoryA.navGrouped, true, "memory sits under its own 工作区 nav group");
  assert.match(memoryA.desc, /按工作区/);
  assert.deepEqual(fixtures.memoryCalls.at(-1), { sessionId: "s_a", projectId: "ws_a" });

  await execute(`
    const select = document.getElementById("memoryWorkspaceSelect");
    select.value = "ws_b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  await settle(300);
  const memoryB = await q(`return {
    selected: document.getElementById("memoryWorkspaceSelect").value,
    learned: [...document.querySelectorAll("#memoryLearnedList .settings-memory-text")].map((el) => el.textContent),
  };`);
  assert.equal(memoryB.selected, "ws_b");
  assert.deepEqual(memoryB.learned, ["周报固定用三段式。", "数据表默认导出为 xlsx。"], "picking a workspace shows that workspace's memory");
  assert.deepEqual(fixtures.memoryCalls.at(-1), { sessionId: null, projectId: "ws_b" }, "another workspace is addressed by projectId, not the active session");

  // Context-menu path: land on the page with the workspace pre-selected.
  await openPage("general");
  await execute(`
    const { openMemorySettingsForProject } = await import("./modules/memory-settings.js");
    await openMemorySettingsForProject("ws_b");
  `);
  await settle(600);
  const memoryViaMenu = await q(`return { page: document.getElementById("settingsPageMemory").hidden === false, selected: document.getElementById("memoryWorkspaceSelect").value };`);
  assert.deepEqual(memoryViaMenu, { page: true, selected: "ws_b" });
  await capture("memory-workspace-b");

  // Sidebar account menu: 意见反馈 sits between 设置 and 帮助与关于 and opens the feedback page.
  await execute(`document.getElementById("settingsCloseBtn").click();`);
  await settle(200);
  const feedbackMenu = await q(`
    return [...document.querySelectorAll("#accountMenuPopover .account-menu-item")].map((el) => el.textContent.trim());
  `);
  assert.deepEqual(feedbackMenu.slice(-3), ["设置", "意见反馈", "帮助与关于"]);
  await execute(`document.querySelector('#accountMenuPopover [data-account-action="feedback"]').click();`);
  await settle(600);
  const feedbackPage = await q(`return document.getElementById("settingsPageFeedback").hidden === false && document.getElementById("settingsPageFeedback").classList.contains("is-active");`);
  assert.equal(feedbackPage, true, "意见反馈 menu item opens the feedback page");

  // `hidden` must win over a component's own display rule, app-wide: the
  // SearXNG URL row is toggled with .hidden while its class says display:flex.
  await openPage("search");
  const searchIqs = await q(`return getComputedStyle(document.getElementById("searchSearxngUrlRow")).display;`);
  assert.equal(searchIqs, "none", "SearXNG URL row must not show while 阿里 IQS is selected");
  fixtures.searchProvider = "searxng";
  await openPage("search");
  const searchSearx = await q(`return getComputedStyle(document.getElementById("searchSearxngUrlRow")).display;`);
  assert.notEqual(searchSearx, "none", "SearXNG URL row shows when SearXNG is selected");
  const licenseInactive = await q(`return { clearHidden: document.getElementById("licenseClearBtn").hidden };`);
  assert.equal(licenseInactive.clearHidden, true, "nothing to remove while inactive");

  console.log("account-pages-visual: ok");
}

app.whenReady().then(main).then(() => app.exit(0)).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
