"use strict";

/** @typedef {{ id: string, skillIds: string[] }} SkillPreset */

const RELIABILITY_CORE_SKILL_IDS = [
  "tob-ask-questions-if-underspecified-ask-questions-if-underspecified",
  "superpowers-systematic-debugging",
  "superpowers-verification-before-completion",
  "superpowers-test-driven-development",
];

const DEV_STARTER_EXTRA_SKILL_IDS = [
  "superpowers-writing-plans",
  "superpowers-executing-plans",
  "superpowers-requesting-code-review",
  "anthropics-webapp-testing",
];

const PM_STARTER_SKILL_IDS = [
  "pm-problem-framing-canvas",
  "pm-prd-development",
  "pm-user-story-mapping",
  "pm-roadmap-planning",
  "anthropics-doc-coauthoring",
];

const MARKETING_STARTER_SKILL_IDS = [
  "marketing-copywriting",
  "marketing-seo-audit",
  "marketing-analytics",
  "marketing-product-marketing",
  "marketing-emails",
];

const OFFICE_STARTER_SKILL_IDS = [
  "anthropics-docx",
  "anthropics-pdf",
  "anthropics-pptx",
  "anthropics-xlsx",
  "anthropics-doc-coauthoring",
];

/** 首次引导与完成判定使用的默认岗位包（以普通办公场景为主） */
const GUIDE_PRESET_ID = "office-starter";

function uniqueSkillIds(ids) {
  return [...new Set(ids)];
}

/** @type {SkillPreset[]} */
const SKILL_PRESETS = [
  {
    id: "office-starter",
    skillIds: OFFICE_STARTER_SKILL_IDS,
  },
  {
    id: "reliability",
    skillIds: RELIABILITY_CORE_SKILL_IDS,
  },
  {
    id: "pm-starter",
    skillIds: PM_STARTER_SKILL_IDS,
  },
  {
    id: "marketing-starter",
    skillIds: MARKETING_STARTER_SKILL_IDS,
  },
  {
    id: "dev-starter",
    skillIds: uniqueSkillIds([...RELIABILITY_CORE_SKILL_IDS, ...DEV_STARTER_EXTRA_SKILL_IDS]),
  },
];

const FEATURED_SKILL_IDS = uniqueSkillIds(SKILL_PRESETS.flatMap((p) => p.skillIds));

const PRESET_BY_ID = Object.fromEntries(SKILL_PRESETS.map((p) => [p.id, p]));

function getPresetById(presetId) {
  if (!presetId || typeof presetId !== "string") return null;
  return PRESET_BY_ID[presetId] || null;
}

function isNicheBlockchainSecuritySkill(skillId) {
  if (!skillId || typeof skillId !== "string") return false;
  return /vulnerability-scanner|token-integration-analyzer/i.test(skillId);
}

function filterSkillIdsInRegistry(registry, skillIds) {
  const known = new Set((registry?.skills || []).map((s) => s.id));
  return skillIds.filter((id) => known.has(id));
}

function presetProgress(preset, { isInstalled, isEnabled }) {
  const skillIds = preset.skillIds;
  let installedCount = 0;
  let enabledCount = 0;
  for (const id of skillIds) {
    if (isInstalled(id)) installedCount += 1;
    if (isEnabled(id)) enabledCount += 1;
  }
  return {
    id: preset.id,
    skillIds,
    total: skillIds.length,
    installedCount,
    enabledCount,
    complete: installedCount === skillIds.length && enabledCount === skillIds.length,
  };
}

function listPresetProgress({ isInstalled, isEnabled }) {
  return SKILL_PRESETS.map((preset) => presetProgress(preset, { isInstalled, isEnabled }));
}

module.exports = {
  SKILL_PRESETS,
  FEATURED_SKILL_IDS,
  GUIDE_PRESET_ID,
  OFFICE_STARTER_SKILL_IDS,
  RELIABILITY_CORE_SKILL_IDS,
  getPresetById,
  isNicheBlockchainSecuritySkill,
  filterSkillIdsInRegistry,
  listPresetProgress,
};
