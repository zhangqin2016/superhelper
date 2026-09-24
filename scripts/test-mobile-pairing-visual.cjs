#!/usr/bin/env node
"use strict";

/**
 * "手机控制" settings page in a real renderer with stateful fixture IPC.
 * Asserts the behaviour the old page got wrong — phones listed by an opaque
 * id, no online state, the approval request far below the QR, one-click
 * unpair — and optionally writes screenshots (both themes):
 *   MOBILE_PAIRING_CAPTURE_DIR=/tmp/x npx electron scripts/test-mobile-pairing-visual.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

if (!app?.whenReady || !BrowserWindow || !ipcMain?.handle) {
  console.error("test-mobile-pairing-visual must run under Electron: npx electron scripts/test-mobile-pairing-visual.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
const captureDir = String(process.env.MOBILE_PAIRING_CAPTURE_DIR || "").trim()
  ? path.resolve(process.env.MOBILE_PAIRING_CAPTURE_DIR)
  : "";

// The main process's Mobile Command state; actions change it and push it.
const state = {
  channel: "online",
  phones: [
    { grantId: "g_iphone", mobileDeviceId: "mweb_49569b5aa1", mobileLabel: "iPhone · Safari", status: "active", approvedAt: "2026-09-20T09:12:00.000Z", createdAt: "2026-09-20T09:11:00.000Z", online: true },
    { grantId: "g_old", mobileDeviceId: "mweb_82872c2f03", mobileLabel: null, status: "active", approvedAt: "2026-07-14T02:00:00.000Z", createdAt: "2026-07-14T01:59:00.000Z", online: false },
  ],
  pending: [],
  capabilities: { observeControl: { enabled: false }, voice: { enabled: false } },
  revoked: [],
  approved: [],
};
const initialPhones = state.phones.map((p) => ({ ...p }));
const snapshot = () => ({ ok: true, channel: state.channel, phones: state.phones, pending: state.pending, capabilities: state.capabilities });
function push() { win.webContents.send("mobile:state", snapshot()); }

async function qrDataUrl(text) {
  return require(path.join(root, "node_modules/qrcode")).toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 320 });
}

function registerFixtureIpc() {
  const handle = (channel, fn) => { try { ipcMain.handle(channel, fn); } catch { /* reused run */ } };
  const ok = (extra = {}) => () => ({ ok: true, ...extra });
  for (const [channel, extra] of Object.entries({
    "notifications:get": { notifications: [] }, "app:get-locale": { locale: "zh-CN" }, "app:get-version": { version: "0.0.0-test" },
    "app:get-edition": { id: "domestic", features: {} }, "app:get-icon-url": { url: "" }, "assistant:feature-flags": { flags: {} },
    "app:get-policy": { region: "china", features: { account: true } }, "media-providers:list": { providers: [] }, "web-credentials:list": { credentials: [] },
    "session:get-skills": { skills: [] }, "session:get-permission": { permission: "default" }, "updates:get-state": { state: { phase: "idle" } },
    "updates:get-settings": { settings: { autoCheck: true } }, "state:full": { state: {} }, "workspace-apps:list": { apps: [] },
    "runtime-packs:list": { packs: [] }, "runtime-packs:location": { locations: [] }, "mail-accounts:list": { accounts: [] },
    "models:list": { presets: [], activePresetId: "" }, "permissions:list": { modes: [], currentMode: "" }, "skills:list": { groups: [], skills: [] },
    "skills:get-preset-guide": { guide: null }, "skills:check-updates": { updates: [] }, "apps:catalog": { json: { apps: [] } },
    "assistant:memory:list": { memories: [] }, "agents:list": { agents: [] }, "agents:get-session": { agent: null },
    "account:status": { loggedIn: true, user: { phoneE164: "+8613800001234" } }, "account:organizations": { organizations: [] },
    "account:current-organization": { organizationId: "" }, "license:status": { activated: true, valid: true },
  })) handle(channel, ok(extra));

  handle("mobile:get-state", () => snapshot());
  handle("mobile:create-challenge", async () => {
    const url = "https://lilyxinjiapo.lilywb.cn";
    const token = "mpt_visual_token_0123456789";
    return { ok: true, challengeId: "mpc_1", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      qr: { url, token, image: await qrDataUrl(`${url}/m/pair#u=${encodeURIComponent(url)}&t=${token}`) } };
  });
  handle("mobile:create-direct-code", () => ({ ok: true, codeId: "mdc_1", code: "K7Q2MX", password: "4815", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }));
  handle("mobile:approve", (_e, grantId) => {
    // The server pushes the activation afterwards, as the real channel does.
    const g = state.pending.find((p) => p.grantId === grantId);
    state.approved.push(grantId);
    setTimeout(() => {
      state.pending = state.pending.filter((p) => p.grantId !== grantId);
      if (g) state.phones = [...state.phones, { ...g, status: "active", approvedAt: new Date().toISOString(), online: true }];
      push();
    }, 50);
    return { ok: true, grantId };
  });
  handle("mobile:deny", () => ({ ok: true }));
  handle("mobile:revoke", (_e, grantId) => {
    state.revoked.push(grantId);
    setTimeout(() => { state.phones = state.phones.filter((p) => p.grantId !== grantId); push(); }, 50);
    return { ok: true, grantId };
  });
}

let win = null;
const execute = (source) => win.webContents.executeJavaScript(`(async () => { ${source} })()`, true);
const q = (source) => execute(`return (() => { ${source} })();`);
async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
  await execute("await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));");
}
async function capture(name) {
  if (!captureDir) return;
  fs.mkdirSync(captureDir, { recursive: true });
  const rect = await q(`const r = document.getElementById("settingsPageMobile").getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 24), y: 0, width: Math.ceil(r.width) + 48, height: Math.min(1400, Math.ceil(r.bottom) + 40) };`);
  const image = await win.webContents.capturePage(rect);
  fs.writeFileSync(path.join(captureDir, `${name}.png`), image.toPNG());
}
async function openMobile() {
  await execute(`const { openSettingsPage } = await import("./modules/settings-panel.js"); openSettingsPage("mobile");`);
  await settle(700);
}
const click = (selector) => execute(`document.querySelector(${JSON.stringify(selector)}).click();`);
const text = (selector) => q(`return document.querySelector(${JSON.stringify(selector)})?.innerText.trim() || "";`);

async function run(theme) {
  await win.webContents.executeJavaScript(`localStorage.setItem("lily.themeMode", ${JSON.stringify(theme)}); location.reload();`);
  await new Promise((r) => setTimeout(r, 1400));
  state.revoked = []; state.pending = []; state.channel = "online";
  state.phones = initialPhones.map((p) => ({ ...p }));
  await openMobile();

  // Summary card: counts and presence, not a bare list.
  assert.equal(await text("#mobilePairSummaryTitle"), "2 台手机已配对");
  assert.match(await text("#mobilePairBridgeStatus"), /1 台正在连接/);

  // Phones by model, with online state; the opaque id is only a short suffix.
  const rows = await q(`return [...document.querySelectorAll("#mobilePairDeviceList .mobile-pair-row")].map((r) => r.innerText.replace(/\\s+/g, " "));`);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /iPhone · Safari · 49569b/);
  assert.match(rows[0], /在线/);
  assert.match(rows[0], /配对于 9月20日/, "dates follow the UI language, not the OS");
  assert.match(rows[1], /手机 · 82872c/);
  assert.match(rows[1], /离线/);
  assert.ok(!rows.join(" ").includes("mweb_"), "no raw browser id on screen");
  assert.equal(await q(`return document.getElementById("mobilePairPendingSection").hidden;`), true, "no empty 'waiting' section");
  await capture(`${theme}-1-paired`);

  // Unpair asks first.
  await click("#mobilePairDeviceList .mobile-pair-row:nth-child(2) .settings-action-btn");
  await settle(100);
  assert.match(await text("#mobilePairDeviceList .mobile-pair-row:nth-child(2)"), /解除后这台手机将无法再控制电脑/);
  assert.equal(state.revoked.length, 0, "first click only asks");
  await capture(`${theme}-2-confirm`);
  await click("#mobilePairDeviceList .mobile-pair-row:nth-child(2) .settings-action-btn--danger");
  await settle(300);
  assert.deepEqual(state.revoked, ["g_old"]);
  assert.equal(await text("#mobilePairSummaryTitle"), "1 台手机已配对");

  // QR panel; a scanning phone's request appears INSIDE it.
  await click("#mobilePairStartBtn");
  await settle(500);
  assert.equal(await q(`return document.getElementById("mobilePairChallenge").hidden;`), false);
  assert.equal(await q(`return document.getElementById("mobilePairQr").naturalWidth > 0;`), true, "a real QR image is shown");
  assert.match(await text("#mobilePairExpiry"), /\d:\d\d 后失效/);
  // A phone scans: the server pushes the request — no polling anywhere.
  state.pending = [{ grantId: "g_new", mobileDeviceId: "mweb_ab12cd34ef", mobileLabel: "Android · 微信", createdAt: new Date().toISOString(), approvalExpiresAt: new Date(Date.now() + 120_000).toISOString() }];
  push();
  await settle(300);
  assert.match(await text("#mobilePairInlinePending"), /Android · 微信 · ab12cd/);
  assert.equal(await q(`return document.getElementById("mobilePairPendingSection").hidden;`), true, "the request is not listed twice");
  await capture(`${theme}-3-qr-request`);
  await click("#mobilePairInlinePending .settings-action-btn--primary");
  await settle(500);
  assert.deepEqual(state.approved.slice(-1), ["g_new"]);
  assert.equal(await q(`return document.getElementById("mobilePairChallenge").hidden;`), true, "approving closes the QR panel");
  assert.equal(await text("#mobilePairSummaryTitle"), "2 台手机已配对");

  // Direct code panel, one panel at a time.
  await click("#mobilePairDirectBtn");
  await settle(300);
  assert.equal(await text("#mobilePairDirectCode"), "K7Q2MX");
  assert.equal(await text("#mobilePairDirectPassword"), "4815");
  assert.equal(await q(`return document.getElementById("mobilePairChallenge").hidden;`), true);
  await capture(`${theme}-4-direct`);
  // A new phone connects with the code: the panel closes itself.
  state.phones = [...state.phones, { grantId: "g_direct", mobileDeviceId: "mweb_ffee001122", mobileLabel: "iPad · Safari", status: "active", approvedAt: new Date().toISOString(), online: true }];
  push();
  await settle(400);
  assert.equal(await q(`return document.getElementById("mobilePairDirect").hidden;`), true, "direct panel closes once the phone connects");
  await capture(`${theme}-5-after-direct`);

  // The channel's own trouble is said plainly.
  state.channel = "signed-out";
  push();
  await settle(200);
  assert.match(await text("#mobilePairBridgeStatus"), /登录账户后/);
  state.channel = "server-outdated";
  push();
  await settle(200);
  assert.match(await text("#mobilePairBridgeStatus"), /服务器版本过旧/);
  await capture(`${theme}-6-outdated`);
  state.channel = "online";
  push();

  // No horizontal overflow at a narrow window.
  win.setSize(700, 1200);
  await settle(300);
  assert.equal(await q(`const p = document.getElementById("settingsPageMobile"); return p.scrollWidth <= p.clientWidth + 1;`), true, "page fits a narrow window");
  win.setSize(1400, 1400);
}

async function main() {
  registerFixtureIpc();
  win = new BrowserWindow({
    show: false, width: 1400, height: 1400, backgroundColor: "#f4f6f8",
    webPreferences: { preload: path.join(root, "src/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await run("light");
  await run("dark");
  console.log("mobile-pairing-visual: ok");
}

app.whenReady().then(main).then(() => app.exit(0), (err) => { console.error(err); app.exit(1); });
