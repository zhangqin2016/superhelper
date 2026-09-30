import { featuredApps, featuredSkills, normalizeApps, normalizeSkills } from "./public-catalog.mjs";
import { normalizePublicWishes } from "./public-wishes.mjs";
import { homeCopy } from "./site-copy-home.mjs";

// Home copy lives in site-copy-home.mjs (the redesign of 2026-09-30); the
// `premiumHome` block in i18n.mjs is no longer read by the page.
export function homeContentFor(locale = "zh") {
  return homeCopy[locale] || homeCopy.zh;
}

export function buildHomeOptionalSections({ appsResult, skillsResult, wishesResult, locale = "zh" } = {}) {
  try {
    const apps = appsResult?.ok
      // Featured first, then the rest: one featured app used to leave a single
      // card stretched across the row.
      ? (() => { const all = normalizeApps(appsResult.data); const picked = featuredApps({ apps: all });
          return [...picked, ...all.filter((app) => !picked.includes(app))].slice(0, 3); })()
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
