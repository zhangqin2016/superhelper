#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildHomeOptionalSections, homeContentFor } from "../web/lib/homepage-content.mjs";
import { homeCopy } from "../web/lib/site-copy-home.mjs";
import { enterpriseContentFor, enterpriseCopy } from "../web/lib/site-copy-enterprise.mjs";

// 2026-09-30 redesign: home + enterprise copy live in their own modules, one
// object per locale with identical keys (a missing key would render blank).
const requiredSections = ["hero", "how", "capabilities", "enterprise", "catalog", "trust", "wishes", "finalCta", "mock", "mini"];

function keyShape(value) {
  if (Array.isArray(value)) return value.map(keyShape);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, keyShape(value[key])]));
  return typeof value;
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

for (const [name, copy] of [["home", homeCopy], ["enterprise", enterpriseCopy]]) {
  for (const locale of ["en", "ar"]) {
    assert.deepEqual(keyShape(copy[locale]), keyShape(copy.zh), `${name} ${locale} copy must have the same keys as zh`);
    const leaks = strings(copy[locale]).filter((text) => /[\u3400-\u9fff]/.test(text));
    assert.deepEqual(leaks, [], `${name} ${locale} copy leaks Chinese`);
  }
  for (const text of strings(copy.zh)) assert.ok(text.trim().length > 0, `${name} zh copy has an empty string`);
}

for (const locale of ["zh", "en", "ar"]) {
  const content = homeContentFor(locale);
  for (const section of requiredSections) {
    assert.ok(content[section], `${locale} homepage missing ${section}`);
  }
  assert.equal(typeof content.hero.title, "string");
  assert.equal(typeof content.hero.primaryCta, "string");
  // The app ships for macOS and Windows; the old note said macOS only.
  assert.match(content.hero.note, /macOS/);
  assert.match(content.hero.note, /Windows/);
}
assert.equal(homeContentFor("xx"), homeCopy.zh, "unknown locale falls back to zh");

assert.equal(homeContentFor("zh").hero.title, "你的项目，终于有人记得。");

const allCopy = JSON.stringify([homeCopy, enterpriseCopy]);
for (const forbidden of ["完全离线", "文件永不上传", "never sent", "fully offline", "离线运行", "works offline"]) {
  assert.equal(allCopy.toLowerCase().includes(forbidden.toLowerCase()), false, `unsupported promise: ${forbidden}`);
}

// The enterprise page describes what shipped — and nothing else.
const ent = JSON.stringify(enterpriseContentFor("zh"));
for (const fact of ["平台", "所有者", "管理员", "手机号", "30 天", "一次性密码", "首次登录", "额度池", "每周额度", "7 天", "单次请求上限", "从不混扣", "按成员、按模型", "变更历史", "暂停", "冻结", "转让", "恢复"]) {
  assert.ok(ent.includes(fact), `enterprise copy should state: ${fact}`);
}
for (const unsupported of ["自助开通", "席位上限", "SSO", "单点登录", "私有化部署"]) {
  assert.equal(ent.includes(unsupported), false, `enterprise copy promises something that did not ship: ${unsupported}`);
}
assert.equal(enterpriseContentFor("xx"), enterpriseCopy.zh);

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

assert.equal(homeContentFor("zh").hero.title.length > 0, true, "core content must not depend on catalogs");

// Optional sections never leave a half-empty grid: hidden when empty, and the
// grids size themselves to the number of items.
const readWeb = (path) => fs.readFileSync(new URL(`../web/${path}`, import.meta.url), "utf8");
const catalogSource = readWeb("components/home/featured-catalog.js");
assert.match(catalogSource, /if \(!apps\.length && !skills\.length\) return null/);
assert.match(catalogSource, /apps\.length \?/);
assert.match(catalogSource, /skills\.length \?/);
assert.match(catalogSource, /Math\.min\(apps\.length, 3\)/);
const wishSource = readWeb("components/home/wish-pool-preview.js");
assert.match(wishSource, /if \(!wishes\.length\) return null/);
assert.match(wishSource, /Math\.min\(wishes\.length, 3\)/);

// Product visuals are code-drawn (the user chose illustrations over
// screenshots): no raster besides the brand icon, no remote assets.
const mockSources = ["components/site/product-mock.js", "components/site/enterprise-mocks.js"].map(readWeb).join("\n");
assert.equal(/https?:\/\/|\.webp|\.jpe?g|base64|placeholder|lorem/i.test(mockSources), false, "mocks must be self-contained and not placeholders");
assert.deepEqual([...mockSources.matchAll(/src="([^"]+)"/g)].map((match) => match[1]), ["/brand/icon.png"]);
assert.match(readWeb("components/home/home-hero.js"), /<ProductMock /);

// One accent: the new stylesheets use only the brand blue and neutrals.
const neutralHex = new Set(["#fff", "#ffffff", "#f4f3f0", "#dcd9d3", "#f7f6f3", "#fcfbf9", "#efede9", "#e9e7e2", "#e3e0da", "#c9ced6", "#f8f7f4"]);
for (const file of ["app/home.css", "app/enterprise.css", "components/site/product-mock.css", "components/site/site-shared.css"]) {
  const css = readWeb(file).toLowerCase();
  for (const [hex] of css.matchAll(/#[0-9a-f]{3,8}\b/g)) assert.ok(neutralHex.has(hex), `${file} introduces a color outside the palette: ${hex}`);
  for (const [rgba] of css.matchAll(/rgba\([^)]*\)/g)) assert.match(rgba, /^rgba\(47, 125, 225,/, `${file} introduces a non-brand rgba: ${rgba}`);
  assert.equal(/indigo|violet|purple|teal/.test(css), false, `${file} names an off-brand hue`);
}

// The enterprise page: its own metadata, sales + sign-in CTAs, localized copy.
const enterprisePage = readWeb("app/enterprise/page.js");
assert.match(enterprisePage, /export const metadata/);
assert.match(enterprisePage, /href="\/contact"/);
assert.match(enterprisePage, /href="\/account\/enterprise"/);
assert.match(enterprisePage, /enterpriseContentFor\(locale\)/);
for (const mock of ["OrgConsoleMock", "IdentityMock", "AddMembersMock", "HistoryMock"]) assert.match(enterprisePage, new RegExp(`<${mock} `));

const webDockerfile = fs.readFileSync(new URL("../web/Dockerfile", import.meta.url), "utf8");
assert.match(
  webDockerfile,
  /COPY\s+--from=builder\s+\/app\/public\s+\.\/public/,
  "production web image must include public assets",
);

const homePageSource = fs.readFileSync(new URL("../web/app/page.js", import.meta.url), "utf8");
for (const component of ["HomeHero", "HomeWorkflows", "HomeCapabilities", "HomeEnterprise", "FeaturedCatalog", "HomeTrust", "WishPoolPreview", "HomeFinalCta"]) {
  assert.match(homePageSource, new RegExp(`import \\{ ${component} \\}`), `homepage missing ${component}`);
}
for (const endpoint of ["/api/apps/catalog", "/api/skills/registry", "/api/wishes"]) {
  assert.equal(homePageSource.includes(endpoint), true, `homepage missing independent fetch for ${endpoint}`);
}
assert.match(homePageSource, /Promise\.all/);
assert.match(homePageSource, /timeoutMs: 1200/);
assert.equal(homePageSource.includes("ProductWindow"), false, "old demo product window is still imported");
assert.match(fs.readFileSync(new URL("../web/components/home/home-hero.js", import.meta.url), "utf8"), /href="\/download"/);
assert.match(fs.readFileSync(new URL("../web/components/home/home-hero.js", import.meta.url), "utf8"), /href="#product-demo"/);

const globalCss = fs.readFileSync(new URL("../web/app/globals.css", import.meta.url), "utf8").toLowerCase();
// The legacy indigo (#586ce8) is gone; --lily-blue now aliases the one brand.
assert.match(globalCss, /--lily-blue: var\(--site-brand\)/);
assert.equal(globalCss.includes("#586ce8"), false, "legacy indigo accent is back");
assert.match(fs.readFileSync(new URL("../web/app/site-system.css", import.meta.url), "utf8"), /--site-brand: #2f7de1;/);
assert.match(globalCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
for (const obsolete of [".kinetic-hero", ".workflow-brain", ".expert-card", "animation: expertfloat", "animation: brainspin"]) {
  assert.equal(globalCss.includes(obsolete), false, `obsolete demo style remains: ${obsolete}`);
}

const layoutSource = fs.readFileSync(new URL("../web/app/layout.js", import.meta.url), "utf8");
assert.match(layoutSource, /personal AI desktop workbench/i);
assert.match(layoutSource, /metadataBase/);
for (const route of ["apps/page.js", "apps/[id]/page.js", "skills/page.js", "wishes/page.js", "download/page.js", "pricing/page.js", "enterprise/page.js"]) {
  const routeSource = fs.readFileSync(new URL(`../web/app/${route}`, import.meta.url), "utf8");
  assert.match(routeSource, /export const metadata|generateMetadata/, `${route} missing distinct metadata`);
}
assert.equal(fs.existsSync(new URL("../web/components/product-window.js", import.meta.url)), false, "obsolete product window component still exists");
assert.equal(globalCss.includes(".product-window"), false, "obsolete product window CSS still exists");

console.log("premium-homepage: ok");
