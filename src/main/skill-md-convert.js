"use strict";

/**
 * Parse Agent Skills SKILL.md frontmatter and build lily-workbench skill.manifest.json.
 */

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  return { meta, body: match[2].trim() };
}

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
    permissions: {
      network: false,
      filesystem: "read",
    },
    guideMd: {
      title,
      priority,
      body:
        (description ? `${description}\n\n` : "") +
        (body || "按 SKILL.md 中的指引完成任务。") +
        `\n\n技能目录：\`{{SKILL_DIR}}\``,
    },
  };
}

module.exports = {
  parseFrontmatter,
  buildManifestFromSkillMd,
};
