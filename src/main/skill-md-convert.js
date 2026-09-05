"use strict";

/**
 * Parse Agent Skills SKILL.md frontmatter and build lily-workbench skill.manifest.json.
 */

const { parseFrontmatter } = require("./skill-frontmatter");

function slugToTitle(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * @param {{ skillId: string, skillMd: string, version?: string, priority?: number }} opts
 */
function buildManifestFromSkillMd({ skillId, skillMd, version = "1.0.0", priority = 50 }) {
  const { meta, body } = parseFrontmatter(skillMd);
  const name = meta.name ? slugToTitle(meta.name) : slugToTitle(skillId.split("-").pop() || skillId);
  const description = meta.description || "";
  const title = name;

  return {
    schemaVersion: 1,
    id: skillId,
    name,
    version,
    description,
    minAppVersion: "0.1.0",
    ...(meta["runtime-packs"] ? { requiredRuntimePacks: require("./skill-runtime-declarations").normalizeRuntimePackIds(meta["runtime-packs"].split(",").map(id => id.trim())) } : {}),
    permissions: {
      network: false,
      filesystem: "read",
      subprocess: false,
    },
    guideMd: {
      title,
      priority,
      body:
        (description ? `${description}\n\n` : "") +
        (body || "Follow the instructions in SKILL.md to complete the task.") +
        `\n\nSkill directory: \`{{SKILL_DIR}}\``,
    },
  };
}

module.exports = {
  parseFrontmatter,
  buildManifestFromSkillMd,
};
