function list(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))] : [];
}

function localized(base, values, locale) {
  const language = String(locale || "zh").toLowerCase().split("-")[0];
  if (values && typeof values === "object" && !Array.isArray(values)) {
    const translated = String(values[language] || "").trim();
    if (translated) return translated;
  }
  return String(base || "").trim();
}

export function normalizeApps(payload = {}) {
  return (Array.isArray(payload.apps) ? payload.apps : [])
    .map((app) => ({
      id: String(app.id || "").trim(),
      name: String(app.name || "").trim(),
      summary: String(app.summary || "").trim(),
      description: String(app.description || "").trim(),
      latestVersion: String(app.latestVersion || "").trim(),
      minPlan: String(app.minPlan || "free").trim(),
      gated: Boolean(app.gated),
      category: String(app.category || "productivity").trim(),
      appType: String(app.appType || "workspace").trim(),
      publisher: String(app.publisher || "Lily Workbench").trim(),
      riskLevel: String(app.riskLevel || "low").trim(),
      featured: Boolean(app.featured),
      tags: list(app.tags),
    }))
    .filter((app) => app.id && app.name && app.summary);
}

export function normalizeSkills(payload = {}, locale = "zh") {
  return (Array.isArray(payload.skills) ? payload.skills : [])
    .filter((skill) => skill.displayInCatalog !== false)
    .map((skill) => ({
      id: String(skill.id || "").trim(),
      name: localized(skill.name, skill.name_i18n, locale),
      description: localized(skill.description, skill.description_i18n, locale),
      latestVersion: String(skill.latestVersion || "").trim(),
      category: String(skill.category || "core").trim(),
      categoryLabel: localized(skill.categoryLabel || skill.category, skill.categoryLabel_i18n, locale),
      publisher: String(skill.publisher || "Lily Workbench").trim(),
      riskLevel: String(skill.riskLevel || "low").trim(),
      featured: Boolean(skill.featured),
    }))
    .filter((skill) => skill.id && skill.name);
}

export function featuredApps(payload = {}) {
  const apps = Array.isArray(payload.apps) ? payload.apps : normalizeApps(payload);
  return apps.filter((app) => app.featured).slice(0, 3);
}

export function featuredSkills(payload = {}) {
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  return skills.filter((skill) => skill.featured).slice(0, 6);
}

export function classifyPublicApiResult(result) {
  if (!result?.ok) return { ok: false, code: result?.code || "CATALOG_UNAVAILABLE", data: null };
  return { ok: true, code: "", data: result.data ?? null };
}
