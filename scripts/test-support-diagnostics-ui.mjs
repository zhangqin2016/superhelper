#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const html = read("src/renderer/index.html");
assert(html.includes('data-settings-link="diagnostics"'), "help tabs should include Diagnostics & repair");
assert(html.includes('id="settingsPageDiagnostics"'), "settings should include a diagnostics repair page");
assert(html.includes('id="supportDiagnosticsRunBtn"'), "diagnostics page should expose a run button");
assert(html.includes('id="supportDiagnosticsRestoreBtn"'), "diagnostics page should expose default model restore");
assert(html.includes('id="supportDiagnosticsSendBtn"'), "diagnostics page should expose upload feedback action");

const settingsPanel = read("src/renderer/modules/settings-panel.js");
assert.match(settingsPanel, /import \{ initSupportDiagnosticsSettings \} from "\.\/support-diagnostics-settings\.js"/);
assert.match(settingsPanel, /diagnostics:\s*\["feedback",\s*"diagnostics",\s*"contact",\s*"about"\]/);
assert.match(settingsPanel, /diagnostics:\s*"help"/);
assert.match(settingsPanel, /initSupportDiagnosticsSettings\(\)/);

const preload = read("src/preload.js");
assert.match(preload, /runSupportDiagnostics:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("support:run-diagnostics"\)/);
assert.match(preload, /submitDiagnosticsFeedback:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\("support:submit-diagnostics-feedback", payload\)/);

const ipcHandlers = read("src/main/ipc-handlers.js");
assert.match(ipcHandlers, /support:run-diagnostics[\s\S]*runSupportDiagnosticsPublic/);
assert.match(ipcHandlers, /support:submit-diagnostics-feedback[\s\S]*submitDiagnosticsFeedbackPublic/);

const zh = JSON.parse(read("src/renderer/i18n/locales/zh-CN.json"));
const en = JSON.parse(read("src/renderer/i18n/locales/en.json"));
const ar = JSON.parse(read("src/renderer/i18n/locales/ar.json"));
for (const key of [
  "settings.nav.diagnostics",
  "settings.diagnosticsRun",
  "settings.diagnosticsRestoreDefaultModel",
  "settings.diagnosticsSend",
  "settings.diagnosticsReady",
  "toast.diagnosticsUploaded",
]) {
  assert(zh[key], `zh missing ${key}`);
  assert(en[key], `en missing ${key}`);
  assert(ar[key], `ar missing ${key}`);
}

console.log("support-diagnostics-ui: ok");
