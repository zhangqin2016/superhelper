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

const homePageSource = fs.readFileSync(new URL("../web/app/page.js", import.meta.url), "utf8");
for (const component of ["HomeHero", "HomeWorkflows", "FeaturedCatalog", "HomeTrust", "WishPoolPreview", "HomeFinalCta"]) {
  assert.match(homePageSource, new RegExp(`import \\{ ${component} \\}`), `homepage missing ${component}`);
}
for (const endpoint of ["/api/apps/catalog", "/api/skills/registry", "/api/wishes"]) {
  assert.equal(homePageSource.includes(endpoint), true, `homepage missing independent fetch for ${endpoint}`);
}
assert.match(homePageSource, /Promise\.all/);
assert.equal(homePageSource.includes("ProductWindow"), false, "old demo product window is still imported");
assert.match(fs.readFileSync(new URL("../web/components/home/home-hero.js", import.meta.url), "utf8"), /href="\/download"/);
assert.match(fs.readFileSync(new URL("../web/components/home/home-hero.js", import.meta.url), "utf8"), /href="#product-demo"/);

const globalCss = fs.readFileSync(new URL("../web/app/globals.css", import.meta.url), "utf8").toLowerCase();
for (const token of ["--lily-ink: #121827", "--lily-blue: #586ce8", "--lily-lavender: #dce3ff", "--lily-pearl: #f6f8fd", "--lily-success: #35a47a"]) {
  assert.equal(globalCss.includes(token), true, `missing premium token ${token}`);
}
assert.match(globalCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
for (const obsolete of [".kinetic-hero", ".workflow-brain", ".expert-card", "animation: expertfloat", "animation: brainspin"]) {
  assert.equal(globalCss.includes(obsolete), false, `obsolete demo style remains: ${obsolete}`);
}

const layoutSource = fs.readFileSync(new URL("../web/app/layout.js", import.meta.url), "utf8");
assert.match(layoutSource, /personal AI desktop workbench/i);
assert.match(layoutSource, /metadataBase/);
for (const route of ["apps/page.js", "apps/[id]/page.js", "skills/page.js", "wishes/page.js", "download/page.js", "pricing/page.js"]) {
  const routeSource = fs.readFileSync(new URL(`../web/app/${route}`, import.meta.url), "utf8");
  assert.match(routeSource, /export const metadata|generateMetadata/, `${route} missing distinct metadata`);
}
assert.equal(fs.existsSync(new URL("../web/components/product-window.js", import.meta.url)), false, "obsolete product window component still exists");
assert.equal(globalCss.includes(".product-window"), false, "obsolete product window CSS still exists");

console.log("premium-homepage: ok");
