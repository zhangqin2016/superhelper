// Ordered access tiers for gated assets (today: workspace apps). A viewer whose
// license carries plan P may access an asset requiring minPlan M iff
// rank(P) >= rank(M).
//
// Fail-closed by design:
//   - an unrecognized VIEWER plan ranks as free (0) — it never unlocks a tier.
//   - an unrecognized / missing asset minPlan ranks as free (0) — so apps with
//     no explicit gating stay visible to everyone (existing apps unaffected).
//
// Every paid plan ranks the same (2026-09-30, owner decision): Pro and Max,
// Enterprise Standard and Premium, and Unlimited have the same features and
// differ only in weekly credits. Licence codes now carry these plan names
// (migration 066 moved every historical licence to premium), so a paid plan
// missing here would rank as free and lock a paying licence out of a gated
// app. The legacy labels (vip, enterprise) rank with them; a pro- or
// vip-gated app therefore means "any paid plan".
const PAID = 1;
export const PLAN_RANK = Object.freeze({
  free: 0,
  trial: 0,
  pro: PAID,
  max: PAID,
  standard: PAID,
  premium: PAID,
  unlimited: PAID,
  vip: PAID,
  enterprise: PAID,
});

// Plans an admin may stamp on an app — the gating ladder we expose today.
export const APP_MIN_PLANS = Object.freeze(["free", "pro", "vip"]);

export function normalizePlan(plan) {
  return String(plan || "").trim().toLowerCase();
}

export function planRank(plan) {
  const rank = PLAN_RANK[normalizePlan(plan)];
  return Number.isInteger(rank) ? rank : 0;
}

export function planAllows(viewerPlan, minPlan) {
  return planRank(viewerPlan) >= planRank(minPlan);
}
