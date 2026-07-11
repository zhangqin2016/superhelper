#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const catalogDir = path.join(ROOT, "resources", "skills-catalog");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "skills-registry", "registry.json"), "utf8"));
const registeredIds = new Set(registry.skills.map((skill) => skill.id));
const catalogIds = fs.readdirSync(catalogDir)
  .filter((id) => fs.statSync(path.join(catalogDir, id)).isDirectory())
  .sort();
assert.deepEqual(
  catalogIds.filter((id) => !registeredIds.has(id)),
  [],
  "every production catalog directory must be registered",
);

const allowedCategories = new Set(registry.categories.map((category) => category.id));
for (const skill of registry.skills) {
  assert.ok(allowedCategories.has(skill.category), `${skill.id} uses undeclared category ${skill.category}`);
  assert.ok(skill.sourceKind, `${skill.id} must preserve source provenance`);
  if (skill.id.startsWith("anthropics-")) {
    assert.equal(skill.publisher, "Anthropic", `${skill.id} must retain its upstream publisher`);
    assert.equal(skill.sourceKind, "bundled-vendor", `${skill.id} must be marked as bundled vendor content`);
  }
}

const expectedPermissions = {
  "lily-app-builder": { network: false, filesystem: "readwrite", subprocess: true },
  "lily-code-repair": { network: false, filesystem: "readwrite", subprocess: true },
  "lily-document-query": { network: false, filesystem: "read", subprocess: true },
  "lily-pdf-form": { network: false, filesystem: "readwrite", subprocess: true },
  "lily-runtime-packs": { network: true, filesystem: "readwrite", subprocess: true },
  "lily-template-fill": { network: false, filesystem: "readwrite", subprocess: true },
  "lily-browser-qa": { network: true, filesystem: "read", subprocess: true },
};
for (const [id, permissions] of Object.entries(expectedPermissions)) {
  const file = path.join(catalogDir, id, "skill.manifest.json");
  assert.ok(fs.existsSync(file), `${id} must have an explicit manifest`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(manifest.permissions, permissions, `${id} permissions must describe real operations`);
  if (id === "lily-browser-qa") assert.deepEqual(manifest.requiredRuntimePacks, ["web-automation"]);
}

const managerSource = fs.readFileSync(path.join(ROOT, "src", "main", "skill-manager.js"), "utf8");
assert.doesNotMatch(managerSource, /anthropics-web-artifacts-builder|anthropics-webapp-testing/);
const stateSource = fs.readFileSync(path.join(ROOT, "src", "main", "skills-state.js"), "utf8");
assert.match(stateSource, /"\{\{RUNTIME_SCRIPTS_DIR\}\}"/, "skill installation must resolve runtime script placeholders");
const bundledBlock = stateSource.match(/const BUNDLED_SKILL_IDS = \[([\s\S]*?)\];/)?.[1] || "";
assert.match(bundledBlock, /lily-diagrams/, "diagram routing must remain a bundled capability");
assert.ok(
  fs.existsSync(path.join(ROOT, "resources", "skills", "lily-diagrams", "skill.manifest.json")),
  "bundled diagram capability must have an installable manifest",
);

const documentVerify = fs.readFileSync(path.join(catalogDir, "lily-document-verify", "SKILL.md"), "utf8");
assert.match(documentVerify, /\{\{RUNTIME_SCRIPTS_DIR\}\}/);
assert.doesNotMatch(documentVerify, /resources\/runtime-scripts\/render_document\.py/);

const settingsSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "modules", "skill-settings.js"), "utf8");
assert.match(settingsSource, /skills\.perm\.subprocess/);
assert.match(settingsSource, /skills\.perm\.runtimePacks/);
for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "renderer", "i18n", "locales", `${locale}.json`), "utf8"));
  assert.ok(messages["skills.perm.subprocess"], `${locale} must localize subprocess permissions`);
  assert.ok(messages["skills.perm.runtimePacks"], `${locale} must localize runtime-pack requirements`);
}
const arabicSkillLocalization = JSON.parse(fs.readFileSync(
  path.join(ROOT, "resources", "skills-registry", "skill-localization", "ar.json"),
  "utf8",
));
assert.ok(arabicSkillLocalization["lily-document-query"], "Arabic catalog localization must include Document Query");
const converterSource = fs.readFileSync(path.join(ROOT, "src", "main", "skill-md-convert.js"), "utf8");
assert.match(converterSource, /subprocess: false/, "generated manifests must state their conservative subprocess default");

const { SKILL_PRESETS, getPresetById } = await import("../src/main/skill-presets.js").then((module) => module.default || module);
const presetShapes = SKILL_PRESETS.map((preset) => [...preset.skillIds].sort().join("\n"));
assert.equal(new Set(presetShapes).size, presetShapes.length, "canonical preset list must not contain duplicate skill sets");
assert.equal(getPresetById("reliability")?.aliasOf, "dev-starter", "legacy preset id must remain compatible");

const engineeringManifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, "resources", "skills", "lily-engineering-rules", "skill.manifest.json"),
  "utf8",
));
const engineeringCatalog = fs.readFileSync(path.join(catalogDir, "lily-engineering-rules", "SKILL.md"), "utf8");
assert.equal(
  engineeringCatalog.includes(engineeringManifest.guideMd_i18n.en.body),
  true,
  "catalog engineering rules must be generated from the mandatory canonical guide",
);
assert.equal(
  registry.skills.find((skill) => skill.id === "lily-engineering-rules")?.latestVersion,
  engineeringManifest.version,
  "mandatory and registry engineering-rule versions must match",
);

console.log(`skill-catalog-governance: ok (${catalogIds.length} catalog skills)`);
