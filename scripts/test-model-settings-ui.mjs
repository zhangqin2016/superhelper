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

for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`));
  assert.equal(
    typeof messages["settings.modelApiOverrideAdvanced"],
    "string",
    `${locale} missing model API override label`,
  );
}

console.log("model-settings-ui: ok");
