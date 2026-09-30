"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiGet, apiPatch, apiPost, apiPostResult } from "../../../lib/api";
import { yuanToCents } from "../../../lib/billing-format.mjs";
import { getI18n } from "../../../lib/i18n.mjs";
import { formatAdminMessage } from "../../../lib/admin-messages.mjs";

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(formData, key, fallback = 0) {
  const raw = text(formData, key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function nullableNumber(formData, key) {
  const raw = text(formData, key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Answers are sentences in the operator's language (admin-messages.mjs); a
// server code never reaches the page raw.
async function say(key, params = {}) {
  const { locale } = await getI18n();
  return formatAdminMessage(key, ["zh", "en", "ar"].includes(locale) ? locale : "zh", params);
}

function wholeNumber(raw) {
  const value = String(raw ?? "").replace(/[,\s，_]/g, "").trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

const PLAN_DAYS = { month: 30, year: 365 };

/**
 * Create or update a product. A subscription plan (resource type "plan") is
 * saved as kind "subscription" with metadata { plan, period }; its unitAmount
 * is the WEEKLY allowance (0 = none) and durationSeconds the paid period —
 * what server/src/services/billing.js planTierOf / createGrantFromPaidOrder read.
 * Works as a plain form action and with useActionState (returns { ok, message }).
 */
export async function upsertBillingProductAction(previousStateOrFormData, maybeFormData) {
  const formData = maybeFormData || previousStateOrFormData;
  const id = text(formData, "id");
  const name = text(formData, "name");
  if (id.length < 2) return { ok: false, message: await say("billingProductIdRequired") };
  if (!name) return { ok: false, message: await say("billingProductNameRequired") };
  const priceCents = yuanToCents(text(formData, "priceYuan"));
  if (priceCents === null) return { ok: false, message: await say("billingPriceInvalid") };
  const resourceType = text(formData, "resourceType");
  let grant;
  if (resourceType === "plan") {
    const plan = text(formData, "planTier");
    const period = text(formData, "planPeriod");
    if (!["pro", "max"].includes(plan)) return { ok: false, message: await say("billingPlanTierRequired") };
    if (!["month", "year"].includes(period)) return { ok: false, message: await say("billingPlanPeriodRequired") };
    const days = text(formData, "planDays") ? wholeNumber(text(formData, "planDays")) : PLAN_DAYS[period];
    if (!days || days < 1 || days > 3650) return { ok: false, message: await say("billingPlanDaysInvalid") };
    const weekly = text(formData, "weeklyUnits") ? wholeNumber(text(formData, "weeklyUnits")) : 0;
    if (weekly === null || weekly > 1_000_000_000) return { ok: false, message: await say("billingPlanUnitsInvalid") };
    grant = { kind: "subscription", resourceType: "plan", unitAmount: weekly, durationSeconds: days * 86400, grantExpiresDays: null, metadata: { plan, period } };
  } else {
    grant = {
      kind: text(formData, "kind"),
      resourceType,
      unitAmount: Math.trunc(numberValue(formData, "unitAmount")),
      durationSeconds: nullableNumber(formData, "durationSeconds"),
      grantExpiresDays: nullableNumber(formData, "grantExpiresDays"),
      metadata: {},
    };
  }
  let res;
  try {
    res = await apiPostResult("/api/admin/billing/products", {
      id,
      name,
      description: text(formData, "description"),
      priceCents,
      currency: text(formData, "currency") || "CNY",
      status: text(formData, "status") || "active",
      sortOrder: Math.trunc(numberValue(formData, "sortOrder")),
      ...grant,
    });
  } catch {
    return { ok: false, message: await say("billingProductFailed") };
  }
  if (!res.ok) {
    const issues = Array.isArray(res.json?.issues) ? res.json.issues : [];
    const fields = [...new Set(issues.map((issue) => (Array.isArray(issue?.path) ? issue.path.join(".") : "")).filter(Boolean))];
    return { ok: false, message: fields.length ? await say("billingProductInvalid", { fields: fields.join(", ") }) : await say("billingProductFailed") };
  }
  revalidatePath("/admin/billing");
  revalidatePath("/admin/billing/products");
  return { ok: true, message: await say("billingProductSaved", { id }) };
}

/**
 * Own model keys (BYOK) only for Pro / Max and organization members — the
 * server setting byokRequiresPlan. PATCH /api/admin/settings requires
 * licenseTrialDays, so the current value is read fresh (never a stale hidden
 * field) and sent back unchanged; nothing else is touched.
 */
export async function setByokRequiresPlanAction(previousStateOrFormData, maybeFormData) {
  const formData = maybeFormData || previousStateOrFormData;
  const next = text(formData, "byokRequiresPlan") === "true";
  try {
    const current = await apiGet("/api/admin/settings");
    const days = Number(current?.settings?.licenseTrialDays);
    if (!Number.isInteger(days) || days < 0) return { ok: false, message: await say("byokRestrictionFailed") };
    await apiPatch("/api/admin/settings", { licenseTrialDays: days, byokRequiresPlan: next });
  } catch {
    return { ok: false, message: await say("byokRestrictionFailed") };
  }
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/settings");
  return { ok: true, value: next, message: await say(next ? "byokRestrictionOn" : "byokRestrictionOff") };
}

export async function upsertPricingRuleAction(formData) {
  await apiPost("/api/admin/billing/pricing-rules", {
    id: text(formData, "id"),
    feature: text(formData, "feature"),
    provider: text(formData, "provider") || null,
    model: text(formData, "model") || null,
    specKey: text(formData, "specKey") || "default",
    resourceType: text(formData, "resourceType"),
    unitCost: Math.trunc(numberValue(formData, "unitCost", 1)),
    freeDailyLimit: nullableNumber(formData, "freeDailyLimit"),
    paidDailyLimit: nullableNumber(formData, "paidDailyLimit"),
    concurrencyLimit: nullableNumber(formData, "concurrencyLimit"),
    enabled: text(formData, "enabled") !== "false",
    metadata: {},
  });
  revalidatePath("/admin/billing");
  revalidatePath("/admin/billing/pricing");
}

// --- orders: sync, refund; statements: reconcile ------------------------------
// Each lands back on its page with the outcome in the URL, so the operator
// sees what happened (and a reload does not repeat it).

function back(path, params) {
  redirect(`${path}?${new URLSearchParams(params)}`);
}

export async function syncBillingOrderAction(formData) {
  const id = text(formData, "id");
  const path = `/admin/billing/orders/${encodeURIComponent(id)}`;
  const res = await apiPostResult(`/api/admin/billing/orders/${encodeURIComponent(id)}/sync`, {});
  const outcomes = (res.json?.results || []).map((r) => r.outcome).join(",");
  revalidatePath(path);
  back(path, res.ok ? { notice: "synced", detail: outcomes || "none" } : { error: res.json?.code || "SYNC_FAILED" });
}

export async function refundBillingOrderAction(formData) {
  const id = text(formData, "id");
  const path = `/admin/billing/orders/${encodeURIComponent(id)}`;
  if (text(formData, "confirm") !== "yes") back(path, { error: "REFUND_NOT_CONFIRMED" });
  const raw = text(formData, "amountYuan");
  const amountCents = raw ? yuanToCents(raw) : undefined;
  if (raw && !amountCents) back(path, { error: "REFUND_AMOUNT_INVALID" });
  const reason = text(formData, "reason");
  if (!reason) back(path, { error: "REFUND_REASON_REQUIRED" });
  const res = await apiPostResult(`/api/admin/billing/orders/${encodeURIComponent(id)}/refund`, { reason, ...(amountCents ? { amountCents } : {}) });
  revalidatePath(path);
  revalidatePath("/admin/billing/orders");
  back(path, res.ok ? { notice: res.json.status === "succeeded" ? "refunded" : "refund_processing" } : { error: res.json?.code || "REFUND_FAILED" });
}

export async function reconcileBillingAction(formData) {
  const provider = text(formData, "provider");
  const billDate = text(formData, "billDate");
  const res = await apiPostResult("/api/admin/billing/reconciliation", { provider, billDate });
  revalidatePath("/admin/billing/reconciliation");
  back("/admin/billing/reconciliation", res.ok ? { notice: res.json.status, provider, billDate } : { error: res.json?.code || "RECONCILE_FAILED", provider, billDate });
}
