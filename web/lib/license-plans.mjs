// Licence plans as the admin console shows them. Mirrors
// server/src/services/license-credits.js (LICENSE_PLANS and the weekly credits
// per seat); scripts/test-admin-license-plans.mjs fails if the two drift.

export const LICENSE_PLAN_WEEKLY_CREDITS = Object.freeze({
  trial: 10000,
  pro: 10000,
  max: 22000,
  standard: 12000,
  premium: 28000,
});
export const UNLIMITED_LICENSE_PLAN = "unlimited";
export const LICENSE_PLANS = Object.freeze([...Object.keys(LICENSE_PLAN_WEEKLY_CREDITS), UNLIMITED_LICENSE_PLAN]);

// Labels an older console sent; the server maps them the same way.
const LEGACY_LICENSE_PLAN = { team: "standard", enterprise: "premium", test: "premium" };

/** A stored plan as one of LICENSE_PLANS (legacy labels mapped, unknown → premium, as the server prices it). */
export function normalizeLicensePlan(plan) {
  const value = LEGACY_LICENSE_PLAN[plan] || plan;
  return LICENSE_PLANS.includes(value) ? value : "premium";
}

export const formatCredits = (value) => Number(value || 0).toLocaleString("en-US");

const fill = (template, params) => String(template || "").replace(/\{(\w+)\}/g, (_, key) => (params[key] ?? `{${key}}`));

/** The localized plan name; an unknown value is shown as itself. */
export function licensePlanName(copy, plan) {
  return copy?.names?.[plan] || String(plan || "-");
}

/** One line on what a plan gives each seat per week. */
export function licensePlanHint(copy, plan) {
  if (plan === UNLIMITED_LICENSE_PLAN) return copy.unlimitedHint;
  return fill(copy.perSeatHint, { n: formatCredits(LICENSE_PLAN_WEEKLY_CREDITS[plan]) });
}

/** Options for the plan select: every plan, named and with its weekly credits. */
export function licensePlanOptions(copy) {
  return LICENSE_PLANS.map((plan) => ({ value: plan, label: `${licensePlanName(copy, plan)} · ${licensePlanHint(copy, plan)}` }));
}

/** The form's override value for the API: empty → null (plan default), else the typed number. */
export function weeklyCreditsFromForm(raw) {
  const value = String(raw ?? "").trim();
  return value === "" ? null : Number(value);
}

export { fill as fillLicenseCopy };
