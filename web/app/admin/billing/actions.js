"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiPost, apiPostResult } from "../../../lib/api";
import { yuanToCents } from "../../../lib/billing-format.mjs";

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

export async function upsertBillingProductAction(formData) {
  await apiPost("/api/admin/billing/products", {
    id: text(formData, "id"),
    kind: text(formData, "kind"),
    name: text(formData, "name"),
    description: text(formData, "description"),
    priceCents: Math.round(numberValue(formData, "priceYuan") * 100),
    currency: text(formData, "currency") || "CNY",
    resourceType: text(formData, "resourceType"),
    unitAmount: Math.trunc(numberValue(formData, "unitAmount")),
    durationSeconds: nullableNumber(formData, "durationSeconds"),
    grantExpiresDays: nullableNumber(formData, "grantExpiresDays"),
    status: text(formData, "status") || "active",
    sortOrder: Math.trunc(numberValue(formData, "sortOrder")),
    metadata: {},
  });
  revalidatePath("/admin/billing");
  revalidatePath("/admin/billing/products");
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
