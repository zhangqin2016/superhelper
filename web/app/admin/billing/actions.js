"use server";

import { revalidatePath } from "next/cache";
import { apiPost } from "../../../lib/api";

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
