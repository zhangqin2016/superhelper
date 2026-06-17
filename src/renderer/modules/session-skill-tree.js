/**
 * Group installed session skills into a collapsible category tree.
 */

/** @typedef {{ id: string, category?: string | null, globallyEnabled?: boolean, sessionEnabled?: boolean }} SessionSkill */

export const TREE_CATEGORY_ORDER = [
  "core",
  "workspace",
  "office",
  "tools",
  "coding",
  "design",
  "media",
  "research",
  "quality",
  "pm",
  "marketing",
  "dev",
  "professional",
  "security",
  "other",
];

const BUNDLED_TOOL_IDS = new Set([
  "lily-vision",
  "lily-image-generation",
  "lily-video-generation",
  "lily-speech-generation",
  "websearch",
  "webfetch",
]);

export function resolveSkillTreeCategory(skill) {
  if (!skill || typeof skill !== "object") return "other";
  if (
    skill.origin === "workspace" ||
    skill.workspaceOnly === true ||
    skill.source === "learned"
  ) {
    return "workspace";
  }
  const raw = skill.category;
  if (typeof raw === "string" && raw.trim()) {
    return TREE_CATEGORY_ORDER.includes(raw) ? raw : "other";
  }
  if (BUNDLED_TOOL_IDS.has(skill.id)) return "tools";
  return "other";
}

/**
 * @param {SessionSkill[]} skills
 * @param {{ enabledKey?: string }} [options]
 * @returns {{ id: string, skills: SessionSkill[], enabledCount: number }[]}
 */
export function groupSkillsForTree(skills, options = {}) {
  const enabledKey = options.enabledKey || "sessionEnabled";
  const buckets = Object.fromEntries(TREE_CATEGORY_ORDER.map((id) => [id, []]));
  for (const skill of skills || []) {
    const cat = resolveSkillTreeCategory(skill);
    buckets[cat].push(skill);
  }

  const groups = [];
  for (const id of TREE_CATEGORY_ORDER) {
    const items = buckets[id];
    if (!items.length) continue;
    items.sort((a, b) => {
      const aEnabled = a[enabledKey] ? 0 : 1;
      const bEnabled = b[enabledKey] ? 0 : 1;
      if (aEnabled !== bEnabled) return aEnabled - bEnabled;
      const aRecommended = (a.featured || a.defaultEligible) ? 0 : 1;
      const bRecommended = (b.featured || b.defaultEligible) ? 0 : 1;
      if (aRecommended !== bRecommended) return aRecommended - bRecommended;
      return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
    });
    let enabledCount = 0;
    for (const skill of items) {
      if (skill[enabledKey]) enabledCount += 1;
    }
    groups.push({ id, skills: items, enabledCount });
  }
  return groups;
}

/**
 * @param {{ enabledCount: number, skills: SessionSkill[] }} group
 */
export function shouldExpandTreeGroup(group, { totalSkills }) {
  if (group.enabledCount > 0) return true;
  if (group.id === "workspace" || group.id === "office" || group.id === "tools") return true;
  return (totalSkills || 0) <= 12;
}
