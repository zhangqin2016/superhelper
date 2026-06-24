#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dictionaries as webDictionaries } from "../web/lib/i18n.mjs";

const require = createRequire(import.meta.url);
const skillManager = require("../src/main/skill-manager.js");
const skillRegistry = require("../src/main/skill-registry.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(root, "resources", "skills");
const skillsCatalogDir = path.join(root, "resources", "skills-catalog");
const localeDir = path.join(root, "src", "renderer", "i18n", "locales");
const registryPath = path.join(root, "resources", "skills-registry", "registry.json");

const forcedChinesePatterns = [
  /用中文/,
  /中文回答/,
  /最后用中文/,
  /默认使用简体中文/,
];
const cjkPattern = /[\u4e00-\u9fff]/;

const localizedGuidePatterns = [
  ...forcedChinesePatterns,
  /技能目录/,
];

function assertNoForcedChinese(text, label) {
  for (const pattern of forcedChinesePatterns) {
    assert.doesNotMatch(text, pattern, `${label} contains forced Chinese prompt: ${pattern}`);
  }
}

function assertNoLocalizedGuideLeak(text, label) {
  for (const pattern of localizedGuidePatterns) {
    assert.doesNotMatch(text, pattern, `${label} contains untranslated guide text: ${pattern}`);
  }
}

function assertNoCjk(text, label) {
  assert.doesNotMatch(text, cjkPattern, `${label} contains untranslated Chinese text`);
}

function assertLocalizedStringMap(manifest, manifestPath, field) {
  const base = manifest[field];
  if (!cjkPattern.test(String(base || ""))) return;
  const i18n = manifest[`${field}_i18n`];
  assert.equal(typeof i18n?.en, "string", `${manifestPath} missing ${field}_i18n.en`);
  assert.equal(typeof i18n?.ar, "string", `${manifestPath} missing ${field}_i18n.ar`);
  assertNoCjk(i18n.en, `${manifestPath} ${field}_i18n.en`);
  assertNoCjk(i18n.ar, `${manifestPath} ${field}_i18n.ar`);
}

function assertLocalizedGuide(manifest, manifestPath) {
  const baseGuide = `${manifest.guideMd?.title || ""}\n${manifest.guideMd?.body || ""}`;
  if (!cjkPattern.test(baseGuide)) return;
  for (const locale of ["en", "ar"]) {
    const guide = manifest.guideMd_i18n?.[locale];
    assert.equal(typeof guide?.title, "string", `${manifestPath} missing guideMd_i18n.${locale}.title`);
    assert.equal(typeof guide?.body, "string", `${manifestPath} missing guideMd_i18n.${locale}.body`);
    assertNoCjk(`${guide.title}\n${guide.body}`, `${manifestPath} guideMd_i18n.${locale}`);
    assertNoLocalizedGuideLeak(`${guide.title}\n${guide.body}`, `${manifestPath} guideMd_i18n.${locale}`);
  }
}

function assertManifestI18nComplete(manifest, manifestPath) {
  for (const field of ["name", "description", "categoryLabel"]) {
    assertLocalizedStringMap(manifest, manifestPath, field);
  }
  assertLocalizedGuide(manifest, manifestPath);
}

function flattenStrings(value, prefix = "") {
  if (typeof value === "string") return [[prefix, value]];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenStrings(item, `${prefix}.${index}`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      flattenStrings(item, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

const enGuide = skillManager.buildAgentGuideContent([], "en");
assert.match(enGuide, /Reply in English by default/);
assertNoLocalizedGuideLeak(enGuide, "English agent guide");

const arGuide = skillManager.buildAgentGuideContent([], "ar");
assert.match(arGuide, /استخدم العربية افتراضياً/);
assertNoLocalizedGuideLeak(arGuide, "Arabic agent guide");

for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
  if (fs.existsSync(skillPath)) {
    const body = fs.readFileSync(skillPath, "utf8");
    assertNoCjk(body, `${entry.name}/SKILL.md`);
    assertNoLocalizedGuideLeak(body, `${entry.name}/SKILL.md`);
  }

  const manifestPath = path.join(skillsDir, entry.name, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assertManifestI18nComplete(manifest, manifestPath);
  for (const locale of ["en", "ar"]) {
    const body = manifest.guideMd_i18n?.[locale]?.body;
    if (typeof body === "string") {
      assertNoLocalizedGuideLeak(body, `${entry.name}/skill.manifest.json ${locale}`);
    }
  }
}

for (const entry of fs.readdirSync(skillsCatalogDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillPath = path.join(skillsCatalogDir, entry.name, "SKILL.md");
  if (fs.existsSync(skillPath)) {
    const body = fs.readFileSync(skillPath, "utf8");
    assertNoCjk(body, `${entry.name}/catalog SKILL.md`);
    assertNoForcedChinese(body, `${entry.name}/catalog SKILL.md`);
  }

  const manifestPath = path.join(skillsCatalogDir, entry.name, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assertManifestI18nComplete(manifest, manifestPath);
}

for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(path.join(localeDir, `${locale}.json`), "utf8"));
  assert.equal(typeof messages["pack.secretWarning"], "string", `${locale} missing pack.secretWarning`);
}

for (const locale of ["en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(path.join(localeDir, `${locale}.json`), "utf8"));
  for (const [key, value] of Object.entries(messages)) {
    if (key === "settings.language.zh-CN") continue;
    if (typeof value === "string") assertNoCjk(value, `${locale}.json ${key}`);
  }
}

for (const locale of ["en", "ar"]) {
  for (const [key, value] of flattenStrings(webDictionaries[locale] || {})) {
    assertNoCjk(value, `web ${locale} ${key}`);
  }
}

const registryJson = JSON.parse(fs.readFileSync(registryPath, "utf8"));
for (const category of registryJson.categories || []) {
  assert.equal(typeof category.label_i18n?.en, "string", `${category.id} missing English category label`);
  assert.equal(typeof category.label_i18n?.ar, "string", `${category.id} missing Arabic category label`);
}
for (const skill of registryJson.skills || []) {
  assert.equal(typeof skill.name_i18n?.en, "string", `${skill.id} missing English name`);
  assert.equal(typeof skill.name_i18n?.ar, "string", `${skill.id} missing Arabic name`);
  assert.equal(typeof skill.description_i18n?.en, "string", `${skill.id} missing English description`);
  assert.equal(typeof skill.description_i18n?.ar, "string", `${skill.id} missing Arabic description`);
  assert.equal(
    typeof skill.categoryLabel_i18n?.en,
    "string",
    `${skill.id} missing English category label`,
  );
  assert.equal(
    typeof skill.categoryLabel_i18n?.ar,
    "string",
    `${skill.id} missing Arabic category label`,
  );
}

const parsedRegistry = skillRegistry.parseRegistryJson(registryJson);
assert.equal(parsedRegistry.ok, true, "registry should parse");
const firstParsedSkill = parsedRegistry.registry.skills[0];
assert.equal(typeof firstParsedSkill.name_i18n?.en, "string", "parser dropped name_i18n.en");
assert.equal(
  typeof firstParsedSkill.description_i18n?.ar,
  "string",
  "parser dropped description_i18n.ar",
);
const firstParsedCategory = parsedRegistry.registry.categories[0];
assert.equal(
  typeof firstParsedCategory.label_i18n?.en,
  "string",
  "parser dropped category label_i18n.en",
);

// Progressive-disclosure skill index: a skill WITHOUT an inlined guideMd (e.g. the
// catalog/anthropics skills) must still be discoverable via the Skill Catalog, with
// its when-to-use description and the path to its full guide. Before this, such
// skills were silently dropped from AGENT.md and the model never knew they existed.
function skillObj(rootDir, id) {
  const dir = path.join(rootDir, id);
  const mp = path.join(dir, "skill.manifest.json");
  const manifest = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, "utf8")) : { id, name: id };
  return { id, skillDir: dir, manifest };
}
const indexSkill = skillObj(skillsCatalogDir, "anthropics-docx");
assert.ok(
  !indexSkill.manifest.guideMd && !indexSkill.manifest.guideMd_i18n,
  "fixture precondition: anthropics-docx should have no inlined guideMd",
);
const indexGuideEn = skillManager.buildAgentGuideContent([indexSkill], "en");
assert.match(indexGuideEn, /## Skill Catalog/, "missing skill index section");
assert.match(
  indexGuideEn,
  /anthropics-docx[/\\]SKILL\.md/,
  "skill without guideMd must be discoverable via its guide path",
);
assert.match(indexGuideEn, /Word document/i, "skill index must carry the when-to-use description");
const indexGuideZh = skillManager.buildAgentGuideContent([indexSkill], "zh-CN");
assert.match(indexGuideZh, /技能目录/, "zh-CN skill index title missing");

const nonMandatoryInlineFixture = {
  ...indexSkill,
  id: "non-mandatory-guide-fixture",
  manifest: {
    id: "non-mandatory-guide-fixture",
    name: "Non Mandatory Guide Fixture",
    description: "Use when testing guide injection size.",
    guideMd: {
      title: "Huge Non Mandatory Guide",
      body: "SHOULD_NOT_INLINE_NON_MANDATORY_GUIDE_BODY",
    },
  },
};
const nonMandatoryGuide = skillManager.buildAgentGuideContent([nonMandatoryInlineFixture], "en");
assert.doesNotMatch(
  nonMandatoryGuide,
  /SHOULD_NOT_INLINE_NON_MANDATORY_GUIDE_BODY/,
  "non-mandatory skill guide bodies must stay out of the every-turn agent prompt",
);
assert.match(nonMandatoryGuide, /Non Mandatory Guide Fixture/, "non-mandatory skill should remain discoverable in the skill index");

console.log("agent guide i18n: ok");
