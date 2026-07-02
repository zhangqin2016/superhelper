import { publicId } from "./ids.js";

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

export function normalizeProductForPublic(product = {}) {
  return {
    id: String(product.id || ""),
    kind: String(product.kind || ""),
    name: String(product.name || ""),
    description: String(product.description || ""),
    priceCents: Number(product.price_cents || 0),
    currency: String(product.currency || "CNY"),
    resourceType: String(product.resource_type || ""),
    unitAmount: Number(product.unit_amount || 0),
    durationSeconds: Number(product.duration_seconds || 0),
    grantExpiresDays: Number(product.grant_expires_days || 0),
    metadata: product.metadata && typeof product.metadata === "object" ? product.metadata : {},
  };
}

export function grantTypeForProduct(product = {}) {
  const resourceType = String(product.resource_type || "");
  if (resourceType === "token") return "paid_tokens";
  if (resourceType === "image_generation") return "paid_image_generations";
  if (resourceType === "video_generation") return "paid_video_generations";
  if (resourceType === "membership") return "membership";
  return "paid_units";
}

export function createGrantFromPaidOrder({ userId, orderId, product, now = new Date() } = {}) {
  const unitTotal = Number(product?.unit_amount || 0);
  const resourceType = String(product?.resource_type || "");
  const expiresAt = product?.duration_seconds
    ? new Date(now.getTime() + Number(product.duration_seconds) * 1000)
    : addDays(now, Number(product?.grant_expires_days || 365));
  return {
    id: publicId("grant"),
    user_id: userId,
    source_type: "order",
    source_id: orderId,
    grant_type: grantTypeForProduct(product),
    resource_type: resourceType,
    token_total: resourceType === "token" ? unitTotal : 0,
    token_remaining: resourceType === "token" ? unitTotal : 0,
    unit_total: unitTotal,
    unit_remaining: unitTotal,
    starts_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: "active",
    metadata: { productId: product?.id || "" },
  };
}

export function validatePaymentNotification({ order, amountCents, currency } = {}) {
  if (!order) return { ok: false, code: "ORDER_NOT_FOUND" };
  if (order.status === "paid") return { ok: false, code: "ORDER_ALREADY_PAID" };
  if (order.status !== "pending") return { ok: false, code: "ORDER_NOT_PAYABLE" };
  if (Number(order.amount_cents || 0) !== Number(amountCents || 0)) {
    return { ok: false, code: "PAYMENT_AMOUNT_MISMATCH" };
  }
  if (String(order.currency || "CNY") !== String(currency || "CNY")) {
    return { ok: false, code: "PAYMENT_CURRENCY_MISMATCH" };
  }
  return { ok: true };
}

export function choosePricingRule(rules = [], { feature, provider = "", model = "", specKey = "default" } = {}) {
  const enabled = (rules || []).filter((rule) => rule?.enabled !== false && rule?.feature === feature);
  const norm = (value) => String(value || "");
  const candidates = [
    (rule) => norm(rule.provider) === norm(provider) && norm(rule.model) === norm(model) && norm(rule.spec_key) === norm(specKey),
    (rule) => norm(rule.provider) === norm(provider) && !norm(rule.model) && norm(rule.spec_key) === norm(specKey),
    (rule) => !norm(rule.provider) && !norm(rule.model) && norm(rule.spec_key) === norm(specKey),
    (rule) => !norm(rule.provider) && !norm(rule.model) && norm(rule.spec_key) === "default",
  ];
  for (const match of candidates) {
    const found = enabled.find(match);
    if (found) return found;
  }
  return null;
}

export function pricingUnitCost(rule) {
  const value = Number(rule?.unit_cost ?? rule?.unitCost ?? 1);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.trunc(value));
}
