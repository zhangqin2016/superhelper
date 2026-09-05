"use strict";

const { PACK_SPECS } = require("./runtime-pack-specs");

const MAX_PACK_IDS = 64;
const MAX_REGISTRY_SKILLS = 10000;

function normalizeRuntimePackIds(value) {
  try {
    if (!Array.isArray(value) || value.length > MAX_PACK_IDS) return [];
    return [...new Set(value.filter((id) => typeof id === "string"
      && id.length <= 100 && Object.hasOwn(PACK_SPECS, id)))];
  } catch {
    return [];
  }
}

// Ordered additive union: installed (or explicitly supplied workspace) manifest,
// then bundled registry. The caller unions its legacy table; no declaration can
// remove an existing requirement. Reads are fresh, and each source fails alone.
function declaredRuntimePacksForSkill(skillId, options = {}) {
  if (process.env.LILY_SKILL_RUNTIME_DECLARATIONS === "0"
    || typeof skillId !== "string" || !/^[a-z][a-z0-9-]{1,99}$/.test(skillId)) return [];
  const ids = [];
  try {
    const manifest = Object.hasOwn(options, "manifest")
      ? options.manifest : require("./skills-state").readInstalledManifest(skillId);
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)
      && (!Object.hasOwn(manifest, "schemaVersion") || manifest.schemaVersion === 1)
      && (!Object.hasOwn(manifest, "id") || manifest.id === skillId)) {
      ids.push(...normalizeRuntimePackIds(manifest.requiredRuntimePacks));
    }
  } catch { /* Retain other sources if installed metadata is unreadable. */ }
  try {
    const registry = Object.hasOwn(options, "registry")
      ? options.registry : require("./skill-registry").loadBundledRegistry();
    if (Array.isArray(registry?.skills) && registry.skills.length <= MAX_REGISTRY_SKILLS) {
      const entry = registry.skills.find((skill) => skill?.id === skillId);
      ids.push(...normalizeRuntimePackIds(entry?.requiredRuntimePacks));
    }
  } catch { /* Retain installed declarations if registry metadata is unreadable. */ }
  return [...new Set(ids)];
}

module.exports = { normalizeRuntimePackIds, declaredRuntimePacksForSkill };
