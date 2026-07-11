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
assert.match(publicApiSource, /AbortSignal\.timeout\(5000\)/);

console.log("web-public-catalog: ok");
