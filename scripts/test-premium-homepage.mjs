#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

import { dictionaries } from "../web/lib/i18n.mjs";
import { buildHomeOptionalSections, homeContentFor } from "../web/lib/homepage-content.mjs";

const requiredSections = ["hero", "problem", "workflows", "trust", "catalog", "wishes", "finalCta"];

for (const locale of ["zh", "en", "ar"]) {
  const content = homeContentFor(dictionaries[locale]);
  for (const section of requiredSections) {
    assert.ok(content[section], `${locale} homepage missing ${section}`);
  }
  assert.equal(typeof content.hero.title, "string");
  assert.equal(typeof content.hero.primaryCta, "string");
}

assert.equal(homeContentFor(dictionaries.zh).hero.title, "你的项目，终于有人记得。");

const allCopy = JSON.stringify([dictionaries.zh.premiumHome, dictionaries.en.premiumHome, dictionaries.ar.premiumHome]);
for (const forbidden of ["完全离线", "文件永不上传", "never sent", "fully offline"]) {
  assert.equal(allCopy.toLowerCase().includes(forbidden.toLowerCase()), false, `unsupported promise: ${forbidden}`);
}

const optional = buildHomeOptionalSections({
  appsResult: { ok: true, data: { apps: Array.from({ length: 5 }, (_, index) => ({ id: `app-${index}`, name: `App ${index}`, summary: `Summary ${index}`, featured: true })) } },
  skillsResult: { ok: true, data: { skills: Array.from({ length: 8 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`, displayInCatalog: true, featured: true })) } },
  wishesResult: { ok: true, data: { wishes: Array.from({ length: 5 }, (_, index) => ({ id: `wish-${index}`, title: `Wish ${index}`, summary: `Summary ${index}`, status: "planned", supportCount: 10 - index })) } },
  locale: "zh",
});
assert.equal(optional.apps.length, 3);
assert.equal(optional.skills.length, 6);
assert.equal(optional.wishes.length, 3);

assert.deepEqual(buildHomeOptionalSections({
  appsResult: null,
  skillsResult: { ok: false },
  wishesResult: new Error("offline"),
  locale: "zh",
}), { apps: [], skills: [], wishes: [] });

assert.equal(homeContentFor(dictionaries.zh).hero.title.length > 0, true, "core content must not depend on catalogs");

const productWebp = new URL("../web/public/product/lily-workbench-home.webp", import.meta.url);
const productFallback = new URL("../web/public/product/lily-workbench-home-fallback.svg", import.meta.url);
assert.equal(fs.existsSync(productWebp), true, "homepage product WebP is missing");
assert.equal(fs.statSync(productWebp).size < 500 * 1024, true, "homepage product WebP must stay below 500 KB");
assert.equal(fs.existsSync(productFallback), true, "homepage product fallback is missing");
const fallbackSource = fs.readFileSync(productFallback, "utf8");
assert.equal(/base64|https?:\/\/(?!www\.w3\.org)|\/Users\/|placeholder/i.test(fallbackSource), false, "fallback contains unsafe or placeholder content");
assert.match(fallbackSource, /Lily Workbench/);

console.log("premium-homepage: ok");
