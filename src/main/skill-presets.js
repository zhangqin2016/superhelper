"use strict";

/** @typedef {{ id: string, skillIds: string[] }} SkillPreset */

const RELIABILITY_CORE_SKILL_IDS = [
  "lily-coding-core",
  "lily-app-builder",
  "lily-code-repair",
  "lily-ui-quality",
  "lily-browser-qa",
];

const OFFICE_STARTER_SKILL_IDS = [
  "lily-office-intent",
  "lily-pdf-extraction-router",
  "lily-excel-data-analysis",
  "lily-ppt-design-qa",
  "anthropics-docx",
  "anthropics-pdf",
  "anthropics-pptx",
  "anthropics-xlsx",
  "anthropics-doc-coauthoring",
  "lily-template-fill",
  "lily-document-verify",
  "lily-doc-style-reference",
  "lily-document-query",
  "lily-pdf-form",
  "lily-runtime-packs",
];

const CREATIVE_STARTER_SKILL_IDS = [
  "lily-creative-director",
  "lily-prompt-enhancer",
  "lily-image-qa",
  "lily-ui-quality",
];

const RESEARCH_STARTER_SKILL_IDS = [
  "lily-research-synthesis",
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
    id: "dev-starter",
    skillIds: RELIABILITY_CORE_SKILL_IDS,
  },
  {
    id: "creative-starter",
    skillIds: CREATIVE_STARTER_SKILL_IDS,
  },
  {
    id: "research-starter",
    skillIds: RESEARCH_STARTER_SKILL_IDS,
  },
];

const FEATURED_SKILL_IDS = uniqueSkillIds(SKILL_PRESETS.flatMap((p) => p.skillIds));

const PRESET_BY_ID = Object.fromEntries(SKILL_PRESETS.map((p) => [p.id, p]));
const PRESET_ALIASES = Object.freeze({ reliability: "dev-starter" });

function getPresetById(presetId) {
  if (!presetId || typeof presetId !== "string") return null;
  const canonical = PRESET_ALIASES[presetId] || presetId;
  const preset = PRESET_BY_ID[canonical];
  if (!preset) return null;
  return canonical === presetId ? preset : { ...preset, id: presetId, aliasOf: canonical };
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
  CREATIVE_STARTER_SKILL_IDS,
  RESEARCH_STARTER_SKILL_IDS,
  PRESET_ALIASES,
  getPresetById,
  filterSkillIdsInRegistry,
  listPresetProgress,
};
