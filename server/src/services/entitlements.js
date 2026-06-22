// Ordered access tiers for gated assets (today: workspace apps). A viewer whose
// license carries plan P may access an asset requiring minPlan M iff
// rank(P) >= rank(M).
//
// Fail-closed by design:
//   - an unrecognized VIEWER plan ranks as free (0) — it never unlocks a tier.
//   - an unrecognized / missing asset minPlan ranks as free (0) — so apps with
//     no explicit gating stay visible to everyone (existing apps unaffected).
export const PLAN_RANK = Object.freeze({
  free: 0,
  trial: 0,
  standard: 1,
  pro: 1,
  vip: 2,
  enterprise: 3,
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
