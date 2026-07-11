const STATUSES = new Set(["published", "planned", "building", "shipped"]);
const CATEGORIES = new Set(["office", "research", "communication", "data", "creative", "developer", "other"]);

function list(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))] : [];
}

export function normalizePublicWishes(payload = {}) {
  return (Array.isArray(payload.wishes) ? payload.wishes : [])
    .filter((wish) => STATUSES.has(String(wish.status || "")))
    .map((wish) => ({
      id: String(wish.id || "").trim(),
      title: String(wish.title || "").trim(),
      summary: String(wish.summary || "").trim(),
      update: String(wish.update || "").trim(),
      originalLocale: String(wish.originalLocale || "zh").trim(),
      category: CATEGORIES.has(String(wish.category || "")) ? String(wish.category) : "other",
      status: String(wish.status),
      linkedAppIds: list(wish.linkedAppIds),
      linkedSkillIds: list(wish.linkedSkillIds),
    }))
    .filter((wish) => wish.id && wish.title && wish.summary);
}

export function wishQuery(input = {}) {
  const query = new URLSearchParams();
  if (STATUSES.has(String(input.status || ""))) query.set("status", input.status);
  if (CATEGORIES.has(String(input.category || ""))) query.set("category", input.category);
  query.set("sort", input.sort === "recent" ? "recent" : "popular");
  query.set("locale", ["zh", "en", "ar"].includes(input.locale) ? input.locale : "zh");
  return `?${query}`;
}

export function classifyWishResult(result) {
  if (!result?.ok) return { state: "error", wishes: [] };
  const wishes = normalizePublicWishes(result.data);
  return { state: wishes.length ? "ready" : "empty", wishes };
}
