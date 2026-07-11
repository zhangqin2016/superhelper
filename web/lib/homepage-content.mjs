import { featuredApps, featuredSkills, normalizeApps, normalizeSkills } from "./public-catalog.mjs";
import { normalizePublicWishes } from "./public-wishes.mjs";

export function homeContentFor(dictionary = {}) {
  return dictionary.premiumHome || {};
}

export function buildHomeOptionalSections({ appsResult, skillsResult, wishesResult, locale = "zh" } = {}) {
  try {
    const apps = appsResult?.ok
      ? featuredApps({ apps: normalizeApps(appsResult.data) })
      : [];
    const skills = skillsResult?.ok
      ? featuredSkills({ skills: normalizeSkills(skillsResult.data, locale) })
      : [];
    const wishes = wishesResult?.ok
      ? normalizePublicWishes(wishesResult.data).slice(0, 3)
      : [];
    return { apps, skills, wishes };
  } catch {
    return { apps: [], skills: [], wishes: [] };
  }
}
