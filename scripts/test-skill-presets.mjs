#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-presets-"));

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
process.resourcesPath = ROOT;
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
      getVersion: () => "0.1.0",
    },
  },
};

const skillPresets = require(path.join(ROOT, "src/main/skill-presets.js"));
const skillRegistry = require(path.join(ROOT, "src/main/skill-registry.js"));
const skillManager = require(path.join(ROOT, "src/main/skill-manager.js"));

if (skillPresets.SKILL_PRESETS.length !== 5) {
  throw new Error(`expected 5 presets, got ${skillPresets.SKILL_PRESETS.length}`);
}
if (skillPresets.SKILL_PRESETS[0].id !== "office-starter") {
  throw new Error("office-starter should be the first preset");
}
if (skillPresets.GUIDE_PRESET_ID !== "office-starter") {
  throw new Error("guide preset should be office-starter");
}

const bundled = skillRegistry.loadBundledRegistry();
for (const preset of skillPresets.SKILL_PRESETS) {
  const inRegistry = skillPresets.filterSkillIdsInRegistry(bundled, preset.skillIds);
  if (inRegistry.length !== preset.skillIds.length) {
    throw new Error(`preset ${preset.id} missing registry entries`);
  }
}

if (skillPresets.FEATURED_SKILL_IDS.length < 22) {
  throw new Error(`expected 22+ featured skills, got ${skillPresets.FEATURED_SKILL_IDS.length}`);
}

if (!skillPresets.isNicheBlockchainSecuritySkill("tob-building-secure-contracts-solana-vulnerability-scanner")) {
  throw new Error("expected blockchain niche detector");
}
if (skillPresets.isNicheBlockchainSecuritySkill("tob-ask-questions-if-underspecified-ask-questions-if-underspecified")) {
  throw new Error("ask-questions should not be niche blockchain");
}

fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(
  path.join(tmp, "skills-state.json"),
  JSON.stringify({ schemaVersion: 1, skills: {} }),
);
skillManager.bootstrapSkills();

const catalog = await skillManager.checkRegistryUpdates({ fetch: false });
if (!catalog.ok) throw new Error("catalog bootstrap failed");
if (!Array.isArray(catalog.presets) || catalog.presets.length !== 5) {
  throw new Error("catalog should expose 5 presets");
}
if (!Array.isArray(catalog.featuredSkillIds) || catalog.featuredSkillIds.length < 22) {
  throw new Error("catalog should expose featuredSkillIds");
}

const guideBefore = skillManager.getSkillPresetGuideState();
if (!guideBefore.shouldShow) {
  throw new Error("fresh install should show skill preset guide");
}
if (guideBefore.guidePresetId !== "office-starter") {
  throw new Error("guide should target office-starter");
}

const office = catalog.presets.find((p) => p.id === "office-starter");
if (!office || office.total !== 7 || office.enabledCount !== 0) {
  throw new Error(`unexpected office preset progress: ${JSON.stringify(office)}`);
}

const deferred = skillManager.setSkillPresetGuideStatus("deferred");
if (!deferred.ok || !deferred.guide.shouldShow) {
  throw new Error("deferred guide should show again on next launch");
}
if (deferred.guide.status !== "deferred") {
  throw new Error("deferred status not persisted");
}

skillManager.setSkillPresetGuideStatus("dismissed");
if (skillManager.getSkillPresetGuideState().shouldShow) {
  throw new Error("dismissed guide should not show");
}

const applyResult = await skillManager.applySkillPreset("office-starter");
if (!applyResult.ok) {
  throw new Error(`apply office-starter failed: ${JSON.stringify(applyResult)}`);
}
if ((applyResult.installed || []).length !== 7) {
  throw new Error(`expected 7 installs, got ${applyResult.installed?.length}`);
}
if ((applyResult.enabled || []).length !== 7) {
  throw new Error(`expected 7 enabled, got ${applyResult.enabled?.length}`);
}

const after = skillManager.listSkillPresetsPublic().find((p) => p.id === "office-starter");
if (!after?.complete) {
  throw new Error("office-starter preset should be complete after apply");
}

skillManager.setSkillPresetGuideStatus("applied");
if (skillManager.getSkillPresetGuideState().shouldShow) {
  throw new Error("applied guide should not show when office-starter is complete");
}

const sorted = catalog.available || [];
const firstFeatured = sorted.findIndex((s) => skillPresets.FEATURED_SKILL_IDS.includes(s.id));
const firstOther = sorted.findIndex(
  (s) => !skillPresets.FEATURED_SKILL_IDS.includes(s.id),
);
if (firstFeatured >= 0 && firstOther >= 0 && firstFeatured > firstOther) {
  throw new Error("featured skills should sort before others in available list");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-presets: ok");
