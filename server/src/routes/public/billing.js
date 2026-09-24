import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { db } from "../../db.js";
import { verifyWebSessionToken } from "../../services/account-auth.js";
import { clientFeatureEnabled } from "../../services/client-bootstrap.js";
import { normalizeProductForPublic } from "../../services/billing.js";
import { userBalanceDetail, userStatement, userUsageSummary } from "../../services/billing-statements.js";
import { PROVIDER_LABELS } from "../../services/payments/providers.js";
import { paymentService } from "../../services/payments/service.js";

// The buyer's side of payments: products, orders, paying, and their own
// statement. Every state change of an order goes through the payment service;
// these routes authenticate, shape, and never decide money on their own.

const createOrderSchema = z.object({
  productId: z.string().min(2).max(120),
  payProvider: z.enum(["alipay", "wechat"]),
});
const checkoutSchema = z.object({ client: z.enum(["desktop", "mobile"]).default("desktop") });
const orderParamsSchema = z.object({ orderId: z.string().min(3).max(120) });
const statementQuerySchema = z.object({
  before: z.string().max(40).optional().default(""),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  kind: z.enum(["all", "topup", "usage"]).optional().default("all"),
});
const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(180).optional().default(30) });

async function requireWebUser(request, reply) {
  const verified = verifyWebSessionToken(request.cookies?.lily_user_session || "");
  if (!verified.ok) {
    reply.code(401).send({ ok: false, code: verified.code || "USER_LOGIN_REQUIRED" });
    return null;
  }
  const session = await db.selectFrom("user_sessions").selectAll().where("id", "=", verified.sessionId).executeTakeFirst();
  if (!session || session.user_id !== verified.userId || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
    return null;
  }
  return { userId: verified.userId, sessionId: verified.sessionId };
}

function purchaseAllowed(request, reply) {
  if (clientFeatureEnabled(request, "purchase")) return true;
  reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
  return false;
}

function send(reply, result, okStatus = 200) {
  if (!result.ok) return reply.code(result.status || 400).send({ ok: false, code: result.code });
  const { status: _ignored, ...body } = result;
  return reply.code(okStatus).send(body);
}

function publicOrder(order, extra = {}) {
  return {
    id: order.id,
    productId: order.product_id,
    productName: order.product_name || extra.productName || order.product_id,
    provider: order.provider,
    providerLabel: PROVIDER_LABELS[order.provider] || order.provider,
    providerOrderId: order.provider_order_id || "",
    amountCents: Number(order.amount_cents || 0),
    refundedCents: Number(order.refunded_cents || 0),
    currency: order.currency || "CNY",
    status: order.status,
    paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : "",
    expiresAt: order.expires_at ? new Date(order.expires_at).toISOString() : "",
    createdAt: order.created_at ? new Date(order.created_at).toISOString() : "",
    resourceType: order.resource_type || extra.resourceType || "",
    unitAmount: Number(order.unit_amount ?? extra.unitAmount ?? 0),
  };
}

export function registerPublicBillingRoutes(app) {
  const payments = paymentService();

  app.get("/api/billing/products", {
    schema: { tags: ["public:billing"], summary: "List purchasable products and the payment methods that can take money now", response: { 200: okResponse({ products: { type: "array" } }) } },
  }, async (request, reply) => {
    if (!purchaseAllowed(request, reply)) return;
    const { providers, fakePayments } = await payments.availableProviders();
    const products = await db.selectFrom("products").selectAll().where("status", "=", "active").orderBy("sort_order", "asc").orderBy("created_at", "asc").execute();
    return {
      ok: true,
      // Only providers that can complete a real payment are offered.
      paymentProviders: providers.map((id) => ({ id, label: PROVIDER_LABELS[id] })),
      fakePaymentsEnabled: fakePayments,
      products: products.map(normalizeProductForPublic),
    };
  });

  app.post("/api/billing/orders", {
    schema: { tags: ["public:billing"], summary: "Create an order (the price is the product's, set server-side)", body: zodBody(createOrderSchema), response: { 201: okResponse({ order: { type: "object" } }) } },
  }, async (request, reply) => {
    if (!purchaseAllowed(request, reply)) return;
    const input = createOrderSchema.parse(request.body);
    const account = await requireWebUser(request, reply);
    if (!account) return;
    const result = await payments.createOrder({ userId: account.userId, productId: input.productId, provider: input.payProvider });
    if (!result.ok) return send(reply, result);
    return reply.code(201).send({ ok: true, order: publicOrder(result.order) });
  });

  app.post("/api/billing/orders/:orderId/checkout", {
    schema: { tags: ["public:billing"], summary: "Start or resume paying an order: a checkout redirect or a QR code", body: zodBody(checkoutSchema), response: { 200: okResponse({ checkout: { type: "object", additionalProperties: true }, paymentId: { type: "string" } }) } },
  }, async (request, reply) => {
    if (!purchaseAllowed(request, reply)) return;
    const { orderId } = orderParamsSchema.parse(request.params);
    const input = checkoutSchema.parse(request.body || {});
    const account = await requireWebUser(request, reply);
    if (!account) return;
    return send(reply, await payments.checkout({ userId: account.userId, orderId, client: input.client }));
  });

  app.get("/api/billing/orders/:orderId", {
    schema: { tags: ["public:billing"], summary: "One order's current state (asks the provider while it is still unpaid)", response: { 200: okResponse({ order: { type: "object", additionalProperties: true } }) } },
  }, async (request, reply) => {
    if (!purchaseAllowed(request, reply)) return;
    const { orderId } = orderParamsSchema.parse(request.params);
    const account = await requireWebUser(request, reply);
    if (!account) return;
    const result = await payments.orderStatus({ userId: account.userId, orderId });
    if (!result.ok) return send(reply, result);
    const product = await db.selectFrom("products").select(["name", "resource_type", "unit_amount"]).where("id", "=", result.order.product_id).executeTakeFirst();
    const refunds = await db.selectFrom("refunds").select(["id", "amount_cents", "status", "created_at", "succeeded_at"]).where("order_id", "=", orderId).orderBy("created_at", "desc").execute();
    return {
      ok: true,
      order: {
        ...publicOrder(result.order, { productName: product?.name, resourceType: product?.resource_type, unitAmount: product?.unit_amount }),
        refunds: refunds.map((r) => ({ id: r.id, amountCents: r.amount_cents, status: r.status, createdAt: new Date(r.created_at).toISOString() })),
      },
    };
  });

  app.get("/api/billing/orders", {
    schema: { tags: ["public:billing"], summary: "List the current user's orders", response: { 200: okResponse({ orders: { type: "array" } }) } },
  }, async (request, reply) => {
    if (!purchaseAllowed(request, reply)) return;
    const account = await requireWebUser(request, reply);
    if (!account) return;
    const orders = await db.selectFrom("orders")
      .leftJoin("products", "products.id", "orders.product_id")
      .selectAll("orders")
      .select(["products.name as product_name", "products.resource_type as resource_type", "products.unit_amount as unit_amount"])
      .where("orders.user_id", "=", account.userId)
      .orderBy("orders.created_at", "desc")
      .limit(50)
      .execute();
    const { fakePayments } = await payments.availableProviders();
    return { ok: true, fakePaymentsEnabled: fakePayments, orders: orders.map((o) => publicOrder(o)) };
  });

  app.post("/api/billing/orders/:orderId/mock-pay", {
    schema: { tags: ["public:billing"], summary: "Complete an order with a fake payment (never in production)", response: { 200: okResponse({ grantId: { type: "string" } }) } },
  }, async (request, reply) => {
    if (!purchaseAllowed(request, reply)) return;
    const account = await requireWebUser(request, reply);
    if (!account) return;
    const { orderId } = orderParamsSchema.parse(request.params);
    return send(reply, await payments.fakeSettle({ orderId, userId: account.userId }));
  });

  // --- the buyer's own statement ------------------------------------------------

  app.get("/api/billing/statement", {
    schema: { tags: ["public:billing"], summary: "The current user's statement: top-ups, refunds and usage, newest first", querystring: zodBody(statementQuerySchema), response: { 200: okResponse({ lines: { type: "array" }, nextBefore: { type: "string" } }) } },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return;
    const q = statementQuerySchema.parse(request.query || {});
    return { ok: true, ...(await userStatement(account.userId, q)) };
  });

  app.get("/api/billing/usage-summary", {
    schema: { tags: ["public:billing"], summary: "The current user's usage per day and per model", querystring: zodBody(usageQuerySchema), response: { 200: okResponse({ byDay: { type: "array" }, byModel: { type: "array" } }) } },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return;
    const q = usageQuerySchema.parse(request.query || {});
    return { ok: true, ...(await userUsageSummary(account.userId, q)) };
  });

  app.get("/api/billing/balance", {
    schema: { tags: ["public:billing"], summary: "What the current user has left, grant by grant, with expiry", response: { 200: okResponse({ grants: { type: "array" } }) } },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return;
    return { ok: true, grants: await userBalanceDetail(account.userId) };
  });
}
