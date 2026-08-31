"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { buildUsageSummary } = require("../src/main/usage-summary");
const { localDateKey } = require("../src/main/local-date-key");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-usage-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const date = localDateKey();
const prior = new Date(); prior.setDate(prior.getDate() - 1);
const yesterday = localDateKey(prior);
const hostile = '<img src=x onerror="window.usageInjected=1">';
const summary = buildUsageSummary({
  days: [{ date, inputTokens: 2400000, outputTokens: 43000, messageCount: 1 }, { date: yesterday, inputTokens: 1000, outputTokens: 2 }],
  byModel: [
    { date, providerID: "selection", model: "selected-but-never-used", messageCount: 1 },
    { date, providerID: "lily-managed-one", model: "model-actual", inputTokens: 2100000, outputTokens: 35000 },
    { date, providerID: "custom-connection-for-the-same-model", model: "model-actual", inputTokens: 200000, outputTokens: 5000 },
    { date, providerID: "connection-" + "long-id-".repeat(10), model: hostile, inputTokens: 100000, outputTokens: 3000 },
  ],
});
for (const row of [...summary.modelTotals || [], ...summary.today.models || []]) {
  row.label = row.model === "model-actual" ? "Configured model name" : row.model;
  row.connectionType = row.providerID === "unknown" ? "unknown" : row.providerID === "lily-managed-one" ? "managed" : "custom";
}

let win;
app.whenReady().then(async () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const fragment = html.match(/<!-- Usage details start -->([\s\S]*?)<!-- Usage details end -->/)?.[1];
  assert.ok(fragment, "the actual settings page must include the usage details surface");
  const styleUrl = pathToFileURL(path.join(root, "src/renderer/styles.css")).href;
  const page = path.join(temp, "usage.html");
  fs.writeFileSync(page, `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; connect-src 'self' file:; img-src file: data:; font-src 'self' file: data:"><link rel="stylesheet" href="${styleUrl}">
    <style>html,body{height:auto;overflow:auto}body{margin:0;padding:24px;background:var(--bg-surface);font-family:system-ui}main{max-width:920px;margin:auto;min-width:0}h1{font-size:24px;margin:0 0 24px}</style>
    </head><body><main><h1>Usage</h1>${fragment}</main></body></html>`);
  win = new BrowserWindow({ show: false, width: 1100, height: 1050, webPreferences: { contextIsolation: true, sandbox: true } });
  const consoleErrors = [];
  win.webContents.on("console-message", event => {
    if (event.level === "error" || event.level === 3) consoleErrors.push(event.message);
  });
  await win.loadFile(page);
  const run = script => win.webContents.executeJavaScript("(async () => { " + script + " })()");
  const moduleUrl = pathToFileURL(path.join(root, "src/renderer/modules/usage-settings.js")).href;
  const localeUrl = pathToFileURL(path.join(root, "src/renderer/i18n/index.js")).href;
  await run(`return (async () => {
    window.usageFixture = ${JSON.stringify({ ok: true, deviceId: "test-device-with-long-identity", source: "server", summary })};
    window.assistantClient = { getUsageSummary: async () => window.usageFixture };
    window.usageModule = await import(${JSON.stringify(moduleUrl)});
    window.localeModule = await import(${JSON.stringify(localeUrl)});
    await window.localeModule.setLocale('zh-CN', { persist: false });
    window.usageModule.initUsageSettings();
    window.assistantClient.getUsageSummary = async () => { throw Error('offline'); };
    await window.usageModule.refreshUsageSettings();
    window.initialLoadFailed = !document.querySelector('#usageStatus').hidden && !document.querySelector('#usageTodayStats').textContent;
    window.assistantClient.getUsageSummary = async () => window.usageFixture;
    await window.usageModule.refreshUsageSettings();
  })().catch(error => { console.error(error.stack); throw error; })`);
  const check = async (script, message) => assert.ok(await run("return (" + script + ")"), message);
  await check(`window.initialLoadFailed`, "initial failure must not pretend usage is zero");
  await check(`document.querySelectorAll('.usage-day').length === 2`, "daily view has real history");
  await check(`document.querySelector('.usage-day summary').textContent.includes('今天')`, "today uses the summary's local date");
  await run(`document.querySelector('.usage-day summary').click()`);
  await check(`document.querySelector('.usage-day').open && document.querySelectorAll('.usage-day .usage-model-row').length >= 3`, "daily disclosure shows model connections");
  await check(`!window.usageInjected && !document.querySelector('#usageContent img') && document.querySelector('#usageContent').textContent.includes(${JSON.stringify(hostile)})`, "untrusted model IDs must render as text");
  await check(`document.querySelector('#usageContent').textContent.includes('历史记录未记录模型')`, "unknown historical attribution is explicit");
  await run(`document.querySelector('[data-usage-view="models"]').click()`);
  await check(`!document.querySelector('#usageModelsView').hidden && document.querySelector('#usageDatesView').hidden`, "model view toggles exclusively");
  await check(`document.querySelectorAll('#usageModelsView .usage-model-row').length === 4`, "model aggregate includes both connections and unknown history");
  await check(`!document.querySelector('#usageModelsView').textContent.includes('selected-but-never-used')`, "a selected model without runtime tokens is not claimed as used");
  await run(`await window.usageModule.refreshUsageSettings()`);
  await check(`!document.querySelector('#usageModelsView').hidden`, "refresh preserves the selected view");
  await run(`document.querySelector('[data-usage-view="dates"]').click()`);
  await check(`document.querySelector('.usage-day').open`, "refresh preserves expanded dates");
  await run(`document.querySelector('.usage-day summary').focus()`);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise(resolve => setTimeout(resolve, 50));
  await check(`!document.querySelector('.usage-day').open`, "keyboard Enter toggles disclosure");
  await run(`document.querySelector('.usage-day summary').click()`);

  const artifacts = process.env.USAGE_UI_ARTIFACT_DIR;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  for (const [width, locale, theme] of [[1100, "zh-CN", "light"], [390, "zh-CN", "light"], [390, "en", "light"], [1100, "en", "dark"], [390, "ar", "dark"]]) {
    win.setSize(width, 1050);
    await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await window.localeModule.setLocale(${JSON.stringify(locale)}, {persist:false});`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await check(`document.documentElement.scrollWidth <= window.innerWidth + 1`, `${width}/${locale}/${theme}: no document overflow`);
    await check(`Array.from(document.querySelectorAll('.usage-model-name,.usage-model-id,.usage-connection-id')).filter(el => el.getClientRects().length).every(el => el.scrollWidth <= el.clientWidth + 1)`, `${width}/${locale}/${theme}: long identities fit`);
    if (artifacts) fs.writeFileSync(path.join(artifacts, `usage-${width}-${locale}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('[data-usage-view="models"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await check(`document.documentElement.scrollWidth <= window.innerWidth + 1`, `${width}/${locale}/${theme}: model view has no overflow`);
    await check(`getComputedStyle(document.querySelector('[data-usage-view="models"]')).backgroundColor !== 'rgba(0, 0, 0, 0)'`, "selected view has a visible surface");
    if (artifacts) fs.writeFileSync(path.join(artifacts, `usage-models-${width}-${locale}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('[data-usage-view="dates"]').click()`);
  }
  await run(`await window.localeModule.setLocale('en', {persist:false}); window.assistantClient.getUsageSummary = async () => { throw Error('offline'); }; await window.usageModule.refreshUsageSettings();`);
  await check(`document.querySelector('#usageStatus').textContent.includes('Could not refresh') && document.querySelectorAll('.usage-day').length === 2`, "refresh failure retains last data with an explicit status");
  await check(`!document.querySelector('#usageRefresh').disabled`, "failure releases refresh control");
  await run(`window.assistantClient.getUsageSummary = () => new Promise(resolve => window.releaseUsageRead = resolve); window.firstRead = window.usageModule.refreshUsageSettings();`);
  await check(`document.querySelector('#usageRefresh').disabled`, "loading state is visible");
  const emptySummary = buildUsageSummary({});
  await run(`window.assistantClient.getUsageSummary = async () => (${JSON.stringify({ ok: true, source: "local", localReason: "syncing", summary: emptySummary })}); await window.usageModule.refreshUsageSettings(); window.releaseUsageRead(window.usageFixture); await window.firstRead;`);
  await check(`document.querySelectorAll('.usage-day').length === 0 && document.querySelector('#usageDatesView').textContent.includes('No usage')`, "late responses cannot replace a newer empty result");
  await check(`document.querySelector('#usageDataSource').textContent.includes('sync')`, "sync fallback is distinct from network failure");
  assert.deepEqual(consoleErrors, [], "no renderer console errors");
  console.log("usage-settings-ui: disclosure, views, refresh race/errors, XSS, locales and responsive screenshots passed");
}).then(() => finish(0), error => { console.error(error); finish(1); });

function finish(code) {
  win?.destroy();
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error) { console.error("Could not clean UI fixture:", error.message); code = 1; }
  app.exit(code);
}
