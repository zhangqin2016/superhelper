/**
 * Which config rules apply to a target, and in what order they merge.
 *
 * Two defects made this worth its own seam (2026-09-22):
 *
 * 1. Merge order was `priority, updated_at` only. Specificity — the thing an
 *    operator actually means by scoping a rule to one license — was nowhere in
 *    the sort, so a global rule with a larger priority silently won over the
 *    license rule written for one customer. "More specific wins" was a habit
 *    maintained by hand-picked numbers, not a property of the system.
 *
 * 2. The admin preview carried its OWN copy of the matcher, and the copy had
 *    already drifted: it knew nothing about user- or organization-scoped rules,
 *    so the preview lied for exactly the rules hardest to reason about. A
 *    preview that does not run the production selection is not a preview.
 *
 * Both are gone: one matcher, one comparator, used by delivery and preview.
 * Priority keeps its meaning WITHIN a scope, which is where an operator can
 * still order two rules that compete for the same field.
 */

/** Least specific first: this is the merge order, and later wins. */
export const SCOPE_SPECIFICITY = {
  global: 0,
  organization: 1,
  group: 2,
  license: 3,
  user: 4,
  device: 5,
};

/** A scope this build does not know sits just above global: it is narrower than
 *  "everyone" by definition, but must never outrank an explicit device rule. */
export const UNKNOWN_SCOPE_SPECIFICITY = 0.5;

export function scopeSpecificity(scope) {
  const rank = SCOPE_SPECIFICITY[String(scope || "")];
  return Number.isFinite(rank) ? rank : UNKNOWN_SCOPE_SPECIFICITY;
}

function updatedAtMs(profile) {
  const value = new Date(profile?.updated_at ?? 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

/** Merge order: specificity, then priority, then the older edit first. */
export function compareProfilesForMerge(a, b) {
  const bySpecificity = scopeSpecificity(a?.scope) - scopeSpecificity(b?.scope);
  if (bySpecificity !== 0) return bySpecificity;
  const byPriority = Number(a?.priority ?? 0) - Number(b?.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  const byTime = updatedAtMs(a) - updatedAtMs(b);
  if (byTime !== 0) return byTime;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

/**
 * Does this rule apply to this target?
 *
 * `target` carries only identities: deviceId, licenseId, groupId, userId,
 * organizationIds. A field the caller does not know stays empty, and a rule
 * scoped to something unknown simply does not match — it never falls through to
 * "applies to everyone".
 */
export function profileMatchesTarget(profile, target = {}) {
  const scope = String(profile?.scope || "");
  const targetId = profile?.target_id ?? profile?.targetId ?? null;
  if (scope === "global") return !targetId;
  if (!targetId) return false;
  if (scope === "group") return Boolean(target.groupId) && targetId === target.groupId;
  if (scope === "license") return Boolean(target.licenseId) && targetId === target.licenseId;
  if (scope === "device") return Boolean(target.deviceId) && targetId === target.deviceId;
  if (scope === "user") return Boolean(target.userId) && targetId === target.userId;
  if (scope === "organization") {
    return Array.isArray(target.organizationIds) && target.organizationIds.includes(targetId);
  }
  return false;
}

/**
 * The rules that apply to a target, in merge order, with the reason each
 * candidate was kept or dropped. Nothing here reads a database or a clock, so
 * delivery, preview and tests all run the same decision.
 *
 * @param {Array<object>} profiles every stored rule (enabled or not)
 * @param {object} target identities
 * @param {{rolloutAllows?: Function, includeDisabled?: boolean}} [deps]
 * @returns {{applied: Array<object>, skipped: Array<{id: string, scope: string, reason: string}>}}
 */
export function selectProfilesForTarget(profiles = [], target = {}, deps = {}) {
  const rolloutAllows = typeof deps.rolloutAllows === "function" ? deps.rolloutAllows : () => true;
  const applied = [];
  const skipped = [];
  for (const profile of profiles) {
    if (profile?.enabled === false && !deps.includeDisabled) {
      skipped.push({ id: profile.id, scope: profile.scope, reason: "disabled" });
      continue;
    }
    if (!profileMatchesTarget(profile, target)) {
      skipped.push({ id: profile.id, scope: profile.scope, reason: "target_mismatch" });
      continue;
    }
    // Rollout is evaluated AFTER the target matches, so a rule held back by a
    // percentage is distinguishable from one aimed at somebody else.
    if (target.deviceId && !rolloutAllows(profile, target.deviceId)) {
      skipped.push({ id: profile.id, scope: profile.scope, reason: "rollout_withheld" });
      continue;
    }
    applied.push(profile);
  }
  applied.sort(compareProfilesForMerge);
  return { applied, skipped };
}
