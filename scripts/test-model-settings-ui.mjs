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

assert(advancedStart > 0, "model settings must keep a manual advanced section");
assert(customTitle > advancedStart, "advanced section should expose the custom model form first");
assert.equal(html.includes('id="modelApiOverrideBlock"'), false, "settings must not expose a global current-model connection override");
assert(html.includes('id="modelDiagnoseRestoreBtn"'), "model settings should expose diagnose restore action");
assert(html.includes('id="modelDiagnoseRestoreStatus"'), "diagnose restore action should have an inline status area");
assert(html.includes('id="modelLibraryList"'), "model settings should expose one library for official and custom models");
assert.equal(html.includes('id="modelCustomList"'), false, "available models must not be represented as a custom-only list");
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
  /const availablePresets = Array\.isArray\(presets\) \? presets : \[\]/.test(modelSettingsSource),
  "available model rendering must preserve official and custom presets",
);
assert(
  !/\.filter\(\(p\) => p\.custom\)/.test(modelSettingsSource),
  "available model rendering must not filter official presets out",
);
assert(
  /preset\.custom[\s\S]*settings\.modelLibraryCustom[\s\S]*settings\.modelLibraryOfficial/.test(modelSettingsSource),
  "available model rows should identify custom and official sources",
);
assert(
  /if \(preset\.custom\) \{[\s\S]*model-custom-actions/.test(modelSettingsSource),
  "only custom models should expose edit and delete actions",
);
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
  for (const key of [
    "settings.modelDiagnoseRestore",
    "settings.modelDiagnoseRestoreRunning",
    "settings.modelDiagnoseRestoreFixedCustom",
    "settings.modelDiagnoseRestoreFixedGateway",
    "settings.modelDiagnoseRestoreReady",
    "settings.modelDiagnoseRestorePending",
    "settings.modelLibraryOfficial",
    "settings.modelLibraryCustom",
    "settings.modelLibraryEmpty",
  ]) {
    assert.equal(typeof messages[key], "string", `${locale} missing ${key}`);
  }
}

console.log("model-settings-ui: ok");
