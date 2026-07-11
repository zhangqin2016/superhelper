export const PUBLIC_WISH_STATUSES = new Set(["published", "planned", "building", "shipped"]);

export const WISH_CATEGORIES = new Set([
  "office",
  "research",
  "communication",
  "data",
  "creative",
  "developer",
  "other",
]);

const TRANSITIONS = new Map([
  ["pending", new Set(["reviewing", "published", "declined", "merged"])],
  ["reviewing", new Set(["pending", "published", "declined", "merged"])],
  ["published", new Set(["planned", "building", "declined", "merged"])],
  ["planned", new Set(["published", "building", "declined", "merged"])],
  ["building", new Set(["planned", "published", "shipped", "declined", "merged"])],
  ["shipped", new Set(["building", "merged"])],
  ["declined", new Set(["pending", "reviewing", "merged"])],
  ["merged", new Set()],
]);

const ACTION_LIMITS = {
  similar: { max: 30, windowMs: 60_000 },
  create: { max: 5, windowMs: 60 * 60_000 },
  support: { max: 60, windowMs: 60_000 },
};

function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [String(key).trim(), String(item || "").trim()])
      .filter(([key, item]) => key && item),
  );
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function localized(base, map, locale) {
  const normalizedLocale = String(locale || "zh").toLowerCase().split("-")[0];
  const values = stringMap(map);
  const chosen = values[normalizedLocale] || String(base || "").trim();
  return {
    value: chosen,
    usedFallback: Boolean(normalizedLocale !== "zh" && !values[normalizedLocale] && chosen),
  };
}

export function normalizeWishInput(input = {}) {
  const value = {
    title: String(input.title || "").trim(),
    problem: String(input.problem || "").trim(),
    desiredOutcome: String(input.desiredOutcome || "").trim(),
    category: WISH_CATEGORIES.has(String(input.category || "")) ? String(input.category) : "other",
  };
  if (value.title.length < 6 || value.title.length > 160) {
    return { ok: false, code: "WISH_TITLE_INVALID" };
  }
  if (value.problem.length < 12 || value.problem.length > 2000) {
    return { ok: false, code: "WISH_PROBLEM_INVALID" };
  }
  if (value.desiredOutcome.length < 12 || value.desiredOutcome.length > 2000) {
    return { ok: false, code: "WISH_OUTCOME_INVALID" };
  }
  return { ok: true, value };
}

export function canTransitionWish(current, next) {
  const from = String(current || "");
  const to = String(next || "");
  return from === to || Boolean(TRANSITIONS.get(from)?.has(to));
}

export function validateWishPublication(row = {}) {
  const status = String(row.status || "");
  if (!PUBLIC_WISH_STATUSES.has(status)) return { ok: true };
  if (!String(row.public_title || "").trim() || !String(row.public_summary || "").trim()) {
    return { ok: false, code: "WISH_PUBLIC_COPY_REQUIRED" };
  }
  if (status === "shipped") {
    const linkedApps = stringList(row.linked_app_ids);
    const linkedSkills = stringList(row.linked_skill_ids);
    if (linkedApps.length === 0 && linkedSkills.length === 0) {
      return { ok: false, code: "WISH_SHIPPED_LINK_REQUIRED" };
    }
  }
  return { ok: true };
}

export function serializePublicWish(row = {}, { locale = "zh" } = {}) {
  const status = String(row.status || "");
  if (!PUBLIC_WISH_STATUSES.has(status)) return null;
  const publication = validateWishPublication(row);
  if (!publication.ok) return null;

  const title = localized(row.public_title, row.public_title_i18n, locale);
  const summary = localized(row.public_summary, row.public_summary_i18n, locale);
  const update = localized(row.public_update, row.public_update_i18n, locale);
  const normalizedLocale = String(locale || "zh").toLowerCase().split("-")[0];
  const usedFallback = title.usedFallback || summary.usedFallback || update.usedFallback;

  return {
    id: String(row.id || ""),
    title: title.value,
    summary: summary.value,
    update: update.value,
    originalLocale: usedFallback ? "zh" : normalizedLocale,
    category: WISH_CATEGORIES.has(String(row.category || "")) ? String(row.category) : "other",
    status,
    linkedAppIds: stringList(row.linked_app_ids),
    linkedSkillIds: stringList(row.linked_skill_ids),
    supportCount: Math.max(0, Number(row.support_count || 0) || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function serializeSubmitterWish(row = {}) {
  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    problem: String(row.problem || ""),
    desiredOutcome: String(row.desired_outcome || ""),
    category: WISH_CATEGORIES.has(String(row.category || "")) ? String(row.category) : "other",
    status: String(row.status || "pending"),
    submitterStatusNote: String(row.submitter_status_note || ""),
    mergedIntoId: row.merged_into_id ? String(row.merged_into_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function gramSet(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
  const grams = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  if (normalized.length === 1) grams.add(normalized);
  return grams;
}

function similarity(left, right) {
  const a = gramSet(left);
  const b = gramSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function findSimilarWishes(query, rows = [], { limit = 5, threshold = 0.3 } = {}) {
  return rows
    .map((row) => ({ ...row, score: similarity(query, row.public_title || row.title) }))
    .filter((row) => row.score >= threshold)
    .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)));
}

export function mergeSupporterIds(targetIds = [], sourceIds = []) {
  return [...new Set([...targetIds, ...sourceIds].map((item) => String(item || "").trim()).filter(Boolean))];
}

export function createWishActionLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  return {
    take(userId, action) {
      const policy = ACTION_LIMITS[action];
      const user = String(userId || "").trim();
      if (!policy || !user) return false;
      const currentTime = now();
      const key = `${action}:${user}`;
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= currentTime) {
        buckets.set(key, { count: 1, resetAt: currentTime + policy.windowMs });
        return true;
      }
      existing.count += 1;
      if (buckets.size > 5_000) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= currentTime) buckets.delete(bucketKey);
        }
      }
      return existing.count <= policy.max;
    },
  };
}
