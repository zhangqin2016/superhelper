#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const html = read("src/renderer/index.html");
const advancedStart = html.indexOf('id="modelAdvancedBlock"');
const customTitle = html.indexOf('data-i18n="settings.modelCustomTitle"', advancedStart);
const overrideBlock = html.indexOf('id="modelApiOverrideBlock"', advancedStart);
const overrideFields = html.indexOf('id="modelApiCustomFields"', advancedStart);

assert(advancedStart > 0, "model settings must keep a manual advanced section");
assert(customTitle > advancedStart, "advanced section should expose the custom model form first");
assert(overrideBlock > customTitle, "current-model API override must be behind the custom model form");
assert(overrideFields > overrideBlock, "current-model API fields must live inside the override details block");
assert(html.includes('id="modelDiagnoseRestoreBtn"'), "model settings should expose diagnose restore action");
assert(html.includes('id="modelDiagnoseRestoreStatus"'), "diagnose restore action should have an inline status area");
assert(
  /id="modelDiagnoseRestoreBtn"[\s\S]*class="[^"]*\bmodel-restore-icon-btn\b/.test(html),
  "diagnose restore action should be an icon button, not a large text button",
);
assert(
  /id="modelDiagnoseRestoreBtn"[\s\S]*data-i18n-title="settings\.modelDiagnoseRestore"/.test(html)
    && /id="modelDiagnoseRestoreBtn"[\s\S]*data-i18n-aria-label="settings\.modelDiagnoseRestore"/.test(html),
  "diagnose restore icon button must keep tooltip and accessible label",
);
assert(
  /id="modelDiagnoseRestoreBtn"[\s\S]*<svg[\s\S]*<\/svg>[\s\S]*<\/button>/.test(html),
  "diagnose restore action should use a clear restore icon",
);
assert(
  /id="modelDiagnoseRestoreBtn"[\s\S]*data-icon="model-repair"/.test(html),
  "diagnose restore icon should communicate repair/restore, not generic refresh",
);

const modelSettingsSource = read("src/renderer/modules/model-settings.js");
assert(
  /setDiagnoseRestoreStatus\([^)]*"settings\.modelDiagnoseRestoreRunning"/.test(modelSettingsSource),
  "diagnose restore should show an immediate running status before the slow IPC returns",
);
assert(
  /btn\.disabled\s*=\s*true[\s\S]*diagnoseAndRestoreDefaultModel/.test(modelSettingsSource),
  "diagnose restore should disable the button while the recovery is running",
);
assert(
  !/btn\.textContent\s*=\s*t\("settings\.modelDiagnoseRestoreRunning"\)/.test(modelSettingsSource),
  "diagnose restore should not replace the icon button with a long running label",
);

for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`));
  assert.equal(
    typeof messages["settings.modelApiOverrideAdvanced"],
    "string",
    `${locale} missing model API override label`,
  );
  for (const key of [
    "settings.modelDiagnoseRestore",
    "settings.modelDiagnoseRestoreRunning",
    "settings.modelDiagnoseRestoreFixedCustom",
    "settings.modelDiagnoseRestoreFixedGateway",
    "settings.modelDiagnoseRestoreReady",
    "settings.modelDiagnoseRestorePending",
  ]) {
    assert.equal(typeof messages[key], "string", `${locale} missing ${key}`);
  }
}

console.log("model-settings-ui: ok");
