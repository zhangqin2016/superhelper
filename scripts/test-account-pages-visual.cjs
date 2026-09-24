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

const { buildUsageSummary } = require(path.join(root, "src/main/usage-summary.js"));

const dateKey = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Mirrors the on-disk shape observed on 2026-09-24: a gateway model that
// never reports input tokens (input 0, output large) next to a healthy one.
function usageFixture() {
  const gateway = { providerID: "lily-model-gateway", model: "DeepSeek-V4.1-Flash" };
  const healthy = { providerID: "lily-model-direct", model: "deepseek-v4-flash" };
  const days = [];
  const byModel = [];
  for (let i = 0; i < 12; i += 1) {
    const date = dateKey(i);
    const gatewayOut = i === 0 ? 123_800 : 40_000 + i * 3_000;
    const healthyIn = i === 0 ? 0 : 138_000 + i * 1_000;
    const healthyOut = i === 0 ? 0 : 7_700;
    days.push({ date, inputTokens: healthyIn, outputTokens: gatewayOut + healthyOut, messageCount: 12, turnCount: 15 });
    byModel.push({ date, ...gateway, inputTokens: 0, outputTokens: gatewayOut, messageCount: 10, turnCount: 12 });
    if (i > 0) byModel.push({ date, ...healthy, inputTokens: healthyIn, outputTokens: healthyOut, messageCount: 2, turnCount: 3 });
  }
  const summary = buildUsageSummary({ days, byModel, historyDays: 30 });
  const decorate = (row) => ({ ...row, label: row.model, connectionType: row.providerID === "unknown" ? "unknown" : "managed" });
  return {
    ...summary,
    today: { ...summary.today, models: summary.today.models.map(decorate) },
    history: summary.history.map((day) => ({ ...day, models: day.models.map(decorate) })),
    modelTotals: summary.modelTotals.map(decorate),
  };
}

const fixtures = {
  account: {
    loggedIn: true,
    user: { phoneE164: "+8613800001234" },
    entitlements: { tokenBalance: 0, imageGenerationsRemaining: 0, videoGenerationsRemaining: 0, membershipExpiresAt: null },
  },
  organizations: [{ id: "org_1", name: "示例科技有限公司" }],
  license: { activated: true, valid: true, license: { customer: "示例科技", plan: "team", expiresAt: "2027-01-01T00:00:00.000Z" } },
  usage: { ok: true, deviceId: "dev-4f1c2a9e", source: "local", localReason: "syncing", summary: usageFixture() },
  policy: { region: "china", features: { account: true, usage: true } },
  searchProvider: "iqs",
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
  handle("assistant:memory:list", ok({ memories: [] }));
  handle("agents:list", ok({ agents: [] }));
  handle("agents:get-session", ok({ agent: null }));

  handle("account:status", () => ({ ok: true, ...fixtures.account }));
  handle("account:organizations", () => ({ ok: true, organizations: fixtures.organizations }));
  handle("account:current-organization", () => ({ ok: true, organizationId: "" }));
  handle("license:status", () => ({ ok: true, ...fixtures.license }));
  handle("usage:get-summary", () => fixtures.usage);
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
      usageTitleLeft: rect("#usageContent h4").left,
      orgSelectWidth: rect("#accountOrgSelect").width,
      emptyLines: document.querySelectorAll(".account-entitlements-empty").length,
      tiles: document.querySelectorAll(".account-entitlement-card").length,
      cards: document.querySelectorAll("#settingsPageUsage .account-settings-card").length,
      refreshButtons: document.querySelectorAll("#accountRefreshBtn, #usageRefresh").length,
      refreshLabel: document.getElementById("usageRefresh").textContent.trim(),
      sourceColor: getComputedStyle(document.getElementById("usageDataSource")).color,
      todayMeta: document.querySelector("#usageTodayStats .usage-stat-meta").textContent,
      toolbarFirst: document.querySelector(".usage-toolbar").firstElementChild.id,
      rangeColor: getComputedStyle(document.getElementById("usageRangeTotals")).color,
    };
  `);
  const warning = await probeColor("--warning-text-soft");
  const primary = await probeColor("--text-primary");
  assert(usage.orgPaddingTop >= 16, `organization section needs breathing room, got ${usage.orgPaddingTop}px`);
  assert.equal(Math.round(usage.orgTitleLeft), Math.round(usage.usageTitleLeft), "section titles share one left edge");
  assert(usage.orgSelectWidth <= 440, `organization select must not span the page, got ${usage.orgSelectWidth}px`);
  assert.equal(usage.emptyLines, 1, "zero credits collapse to one sentence");
  const buyLink = await q(`return document.querySelectorAll(".account-entitlements-empty .settings-link-button").length;`);
  assert.equal(buyLink, 1, "phone account with purchase enabled gets the buy link");
  assert.equal(usage.tiles, 0, "zero credits render no tiles");
  assert.equal(usage.cards, 0, "usage page carries no nested cards");
  assert.equal(usage.refreshButtons, 1, "exactly one refresh control on the page");
  assert.equal(usage.refreshLabel, "刷新");
  assert.notEqual(usage.sourceColor, warning, "routine sync note must not wear the warning color");
  assert.match(usage.todayMeta, /输入未上报/, "gateway usage with input 0 reads as unreported, not zero");
  assert.equal(usage.toolbarFirst, "usageRangeTotals", "range summary leads the toolbar");
  assert.equal(usage.rangeColor, primary, "range summary is primary text, not a caption");

  fixtures.account = {
    ...fixtures.account,
    entitlements: { tokenBalance: 2_500_000, imageGenerationsRemaining: 40, videoGenerationsRemaining: 3, membershipExpiresAt: "2027-01-01T00:00:00.000Z" },
  };
  await openPage("usage");
  await capture("usage-with-credits");
  const credits = await q(`
    const tiles = [...document.querySelectorAll(".account-entitlement-card")];
    const tops = new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)));
    return { tiles: tiles.length, rows: tops.size, empty: document.querySelectorAll(".account-entitlements-empty").length,
      values: tiles.map((tile) => tile.querySelector("strong").textContent.trim()) };
  `);
  assert.equal(credits.tiles, 4);
  assert.equal(credits.rows, 1, "credits sit on one stat row at desktop width");
  assert.equal(credits.empty, 0);
  assert.equal(credits.values[0], "2,500,000");
  assert.match(credits.values[3], /^2027\/1\/1$/, "membership expiry follows the UI locale, compact for a tile");

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
  await openPage("usage");
  const enterpriseUsage = await q(`return {
    emptyLines: document.querySelectorAll(".account-entitlements-empty").length,
    text: document.querySelector(".account-entitlements-empty")?.textContent || "",
    buyLinks: document.querySelectorAll(".account-entitlements-empty .settings-link-button").length,
  };`);
  assert.equal(enterpriseUsage.emptyLines, 1);
  assert.equal(enterpriseUsage.buyLinks, 0, "no self-serve purchase link when the edition disables billing");
  assert.match(enterpriseUsage.text, /管理员/, "enterprise empty state points at the admin instead of a dead end");
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

  await openPage("usage");
  const usageOut = await q(`return { entitlementsHidden: document.getElementById("accountEntitlementsSection").hidden };`);
  assert.equal(usageOut.entitlementsHidden, true, "credits section disappears while signed out");

  await openPage("license");
  await capture("license-inactive");

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
