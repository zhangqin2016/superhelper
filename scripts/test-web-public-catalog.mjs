#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  classifyPublicApiResult,
  featuredApps,
  featuredSkills,
  normalizeApps,
  normalizeSkills,
} = await import("../web/lib/public-catalog.mjs");

const apps = normalizeApps({ apps: [{
  id: "research-app",
  name: "Research App",
  summary: "Turn mixed sources into an evidence-backed brief.",
  description: "A complete research workspace.",
  latestVersion: "1.2.0",
  minPlan: "free",
  gated: false,
  category: "research",
  appType: "workspace",
  publisher: "Lily Workbench",
  riskLevel: "low",
  featured: true,
  tags: ["research"],
  downloadUrl: "https://private.example/app.zip",
  sha256: "a".repeat(64),
}] });
assert.equal(apps.length, 1);
assert.equal(apps[0].id, "research-app");
assert.equal("downloadUrl" in apps[0], false);
assert.equal("sha256" in apps[0], false);
assert.equal(featuredApps({ apps }).length, 1);

const skills = normalizeSkills({ skills: [
  {
    id: "hidden",
    name: "Hidden runtime layer",
    displayInCatalog: false,
    featured: true,
  },
  {
    id: "research",
    name: "研究综合",
    name_i18n: { en: "Research synthesis" },
    description: "整理来源并形成结论。",
    description_i18n: { en: "Synthesize sources into conclusions." },
    category: "research",
    categoryLabel: "研究",
    categoryLabel_i18n: { en: "Research" },
    publisher: "Lily Workbench",
    riskLevel: "low",
    featured: true,
    displayInCatalog: true,
    downloadUrl: "https://private.example/skill.zip",
    sha256: "b".repeat(64),
    capability: { inputs: ["secret"] },
  },
] }, "en");
assert.deepEqual(skills.map((item) => item.id), ["research"]);
assert.equal(skills[0].name, "Research synthesis");
assert.equal(skills[0].description, "Synthesize sources into conclusions.");
assert.equal("downloadUrl" in skills[0], false);
assert.equal("sha256" in skills[0], false);
assert.equal("capability" in skills[0], false);
assert.equal(featuredSkills({ skills }).length, 1);
assert.equal(normalizeSkills({ skills: [skills[0]] }, "ar")[0].name, "Research synthesis");

assert.deepEqual(classifyPublicApiResult(null), {
  ok: false,
  code: "CATALOG_UNAVAILABLE",
  data: null,
});
assert.deepEqual(classifyPublicApiResult({ ok: true, data: { apps: [] } }), {
  ok: true,
  code: "",
  data: { apps: [] },
});

const publicApiSource = fs.readFileSync(new URL("../web/lib/public-api.js", import.meta.url), "utf8");
assert.match(publicApiSource, /cache: "no-store"/);
assert.match(publicApiSource, /timeoutMs = 5000/);
assert.match(publicApiSource, /AbortSignal\.timeout\(timeoutMs\)/);

const appsPage = fs.readFileSync(new URL("../web/app/apps/page.js", import.meta.url), "utf8");
const appDetailPage = fs.readFileSync(new URL("../web/app/apps/[id]/page.js", import.meta.url), "utf8");
const appCatalog = fs.readFileSync(new URL("../web/components/app-catalog.js", import.meta.url), "utf8");
assert.match(appsPage, /publicApiGet\("\/api\/apps\/catalog"\)/);
assert.match(appsPage, /normalizeApps/);
assert.match(appCatalog, /href=\{`\/apps\/\$\{app\.id\}`\}/);
assert.match(appDetailPage, /publicApiGet\("\/api\/apps\/catalog"\)/);
assert.match(appDetailPage, /href="\/download"/);
assert.equal(appDetailPage.includes("downloadUrl"), false);
assert.equal(appDetailPage.includes("sha256"), false);

const skillsPage = fs.readFileSync(new URL("../web/app/skills/page.js", import.meta.url), "utf8");
const skillCatalog = fs.readFileSync(new URL("../web/components/skill-catalog.js", import.meta.url), "utf8");
assert.match(skillsPage, /publicApiGet\("\/api\/skills\/registry"\)/);
assert.match(skillsPage, /normalizeSkills/);
assert.match(skillCatalog, /href="\/download"/);
for (const privateField of ["downloadUrl", "sha256", "capability"]) {
  assert.equal(skillCatalog.includes(privateField), false, `skill catalog exposes ${privateField}`);
}

const siteNav = fs.readFileSync(new URL("../web/components/site-nav.js", import.meta.url), "utf8");
const siteFooter = fs.readFileSync(new URL("../web/components/site-footer.js", import.meta.url), "utf8");
for (const href of ["/apps", "/skills", "/wishes", "/pricing", "/account", "/download"]) {
  assert.equal(siteNav.includes(`"${href}"`), true, `public nav missing ${href}`);
}
assert.match(siteNav, /onClick=\{\(\) => setOpen\(false\)\}/);
assert.match(siteFooter, /href="\/apps"/);
assert.match(siteFooter, /href="\/skills"/);
assert.match(siteFooter, /href="\/wishes"/);

const { dictionaries } = await import("../web/lib/i18n.mjs");
for (const locale of ["zh", "en", "ar"]) {
  for (const key of ["apps", "skills", "wishes", "pricing", "account", "download"]) {
    assert.equal(typeof dictionaries[locale].nav[key], "string", `${locale} nav missing ${key}`);
  }
}

console.log("web-public-catalog: ok");
