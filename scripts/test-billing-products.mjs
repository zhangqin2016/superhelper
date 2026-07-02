#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-session-secret";

const billing = await import("../server/src/services/billing.js");

const tokenProduct = {
  id: "token_100k",
  kind: "token_pack",
  name: "100K Token",
  price_cents: 990,
  currency: "CNY",
  resource_type: "token",
  unit_amount: 100000,
  grant_expires_days: 365,
};

const imageProduct = {
  id: "image_20",
  kind: "image_pack",
  name: "20 image generations",
  price_cents: 1290,
  currency: "CNY",
  resource_type: "image_generation",
  unit_amount: 20,
  grant_expires_days: 180,
};

assert.deepEqual(billing.normalizeProductForPublic(tokenProduct), {
  id: "token_100k",
  kind: "token_pack",
  name: "100K Token",
  description: "",
  priceCents: 990,
  currency: "CNY",
  resourceType: "token",
  unitAmount: 100000,
  durationSeconds: 0,
  grantExpiresDays: 365,
  metadata: {},
});

const tokenGrant = billing.createGrantFromPaidOrder({
  userId: "usr_test",
  orderId: "ord_test",
  product: tokenProduct,
  now: new Date("2026-07-02T00:00:00.000Z"),
});
assert.equal(tokenGrant.source_type, "order");
assert.equal(tokenGrant.source_id, "ord_test");
assert.equal(tokenGrant.grant_type, "paid_tokens");
assert.equal(tokenGrant.resource_type, "token");
assert.equal(tokenGrant.unit_total, 100000);
assert.equal(tokenGrant.expires_at, "2027-07-02T00:00:00.000Z");

const imageGrant = billing.createGrantFromPaidOrder({
  userId: "usr_test",
  orderId: "ord_img",
  product: imageProduct,
  now: new Date("2026-07-02T00:00:00.000Z"),
});
assert.equal(imageGrant.grant_type, "paid_image_generations");
assert.equal(imageGrant.resource_type, "image_generation");
assert.equal(imageGrant.unit_total, 20);

assert.equal(billing.grantTypeForProduct({ resource_type: "video_generation" }), "paid_video_generations");
assert.equal(billing.grantTypeForProduct({ resource_type: "membership" }), "membership");

assert.deepEqual(billing.validatePaymentNotification({
  order: { id: "ord_1", amount_cents: 990, currency: "CNY", status: "pending" },
  amountCents: 990,
  currency: "CNY",
}), { ok: true });

assert.equal(billing.validatePaymentNotification({
  order: { id: "ord_1", amount_cents: 990, currency: "CNY", status: "pending" },
  amountCents: 1,
  currency: "CNY",
}).code, "PAYMENT_AMOUNT_MISMATCH");

assert.equal(billing.validatePaymentNotification({
  order: { id: "ord_1", amount_cents: 990, currency: "CNY", status: "paid" },
  amountCents: 990,
  currency: "CNY",
}).code, "ORDER_ALREADY_PAID");

const pricingRules = [
  { id: "default", feature: "image_generation", provider: null, model: null, spec_key: "default", resource_type: "image_generation", unit_cost: 1, enabled: true },
  { id: "volcengine", feature: "image_generation", provider: "volcengine", model: null, spec_key: "volcengine", resource_type: "image_generation", unit_cost: 2, enabled: true },
  { id: "disabled", feature: "image_generation", provider: "kling", model: null, spec_key: "kling", resource_type: "image_generation", unit_cost: 9, enabled: false },
];
assert.equal(billing.choosePricingRule(pricingRules, {
  feature: "image_generation",
  provider: "volcengine",
  specKey: "volcengine",
})?.unit_cost, 2);
assert.equal(billing.choosePricingRule(pricingRules, {
  feature: "image_generation",
  provider: "kling",
  specKey: "kling",
})?.unit_cost, 1);
assert.equal(billing.pricingUnitCost(null), 1);
assert.equal(billing.pricingUnitCost({ unit_cost: 3 }), 3);

console.log("billing product helpers ok");
