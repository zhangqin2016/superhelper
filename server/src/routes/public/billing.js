import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { verifyWebSessionToken } from "../../services/account-auth.js";
import { getPaymentAdminSettings } from "../../services/app-settings.js";
import { clientFeatureEnabled } from "../../services/client-bootstrap.js";
import {
  createGrantFromPaidOrder,
  normalizeProductForPublic,
  validatePaymentNotification,
} from "../../services/billing.js";

const createOrderSchema = z.object({
  productId: z.string().min(2).max(120),
  payProvider: z.enum(["alipay", "wechat"]),
});

const devSettleSchema = z.object({
  orderId: z.string().min(3).max(120),
  amountCents: z.number().int().min(0),
  currency: z.string().min(3).max(8).default("CNY"),
  providerOrderId: z.string().min(3).max(160).optional(),
});

const orderParamsSchema = z.object({
  orderId: z.string().min(3).max(120),
});

async function fetchActiveProduct(productId) {
  return db
    .selectFrom("products")
    .selectAll()
    .where("id", "=", productId)
    .where("status", "=", "active")
    .executeTakeFirst();
}

async function requireWebUser(request, reply) {
  const sessionToken = request.cookies?.lily_user_session || "";
  const verified = verifyWebSessionToken(sessionToken);
  if (!verified.ok) {
    reply.code(401).send({ ok: false, code: verified.code || "USER_LOGIN_REQUIRED" });
    return null;
  }
  const session = await db
    .selectFrom("user_sessions")
    .selectAll()
    .where("id", "=", verified.sessionId)
    .executeTakeFirst();
  if (!session || session.user_id !== verified.userId || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
    return null;
  }
  return { userId: verified.userId, sessionId: verified.sessionId };
}

async function grantPaidOrder({ order, product, providerOrderId }) {
  return db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom("orders").selectAll().where("id", "=", order.id).executeTakeFirst();
    const valid = validatePaymentNotification({
      order: current,
      amountCents: order.amount_cents,
      currency: order.currency,
    });
    if (!valid.ok) return valid;
    const grant = createGrantFromPaidOrder({
      userId: current.user_id,
      orderId: current.id,
      product,
    });
    await trx
      .updateTable("orders")
      .set({
        status: "paid",
        paid_at: new Date(),
        provider_order_id: providerOrderId || current.provider_order_id || publicId("pay"),
        updated_at: new Date(),
      })
      .where("id", "=", current.id)
      .execute();
    await trx.insertInto("wallet_grants").values(grant).execute();
    await trx
      .insertInto("wallet_ledger")
      .values({
        id: publicId("ledger"),
        user_id: current.user_id,
        grant_id: grant.id,
        event_type: "grant",
        resource_type: grant.resource_type,
        token_delta: grant.resource_type === "token" ? grant.unit_total : 0,
        unit_delta: grant.unit_total,
        money_delta_cents: current.amount_cents,
        source_type: "order",
        source_id: current.id,
        idempotency_key: `order_paid:${current.id}`,
        metadata: { productId: product.id, provider: current.provider },
      })
      .execute();
    return { ok: true, grantId: grant.id };
  });
}

export function registerPublicBillingRoutes(app) {
  app.get(
    "/api/billing/products",
    {
      schema: {
        tags: ["public:billing"],
        summary: "List purchasable products",
        response: { 200: okResponse({ products: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      if (!clientFeatureEnabled(request, "purchase")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      const payment = await getPaymentAdminSettings();
      const products = await db
        .selectFrom("products")
        .selectAll()
        .where("status", "=", "active")
        .orderBy("sort_order", "asc")
        .orderBy("created_at", "asc")
        .execute();
      return {
        ok: true,
        paymentProviders: [
          ...(payment.wechat.enabled ? [{ id: "wechat", label: "微信" }] : []),
          ...(payment.alipay.enabled ? [{ id: "alipay", label: "支付宝" }] : []),
        ],
        fakePaymentsEnabled: Boolean(payment.fakePaymentsEnabled),
        products: products.map(normalizeProductForPublic),
      };
    },
  );

  app.post(
    "/api/billing/orders",
    {
      schema: {
        tags: ["public:billing"],
        summary: "Create a user billing order",
        body: zodBody(createOrderSchema),
        response: { 201: okResponse({ order: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      if (!clientFeatureEnabled(request, "purchase")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      const input = createOrderSchema.parse(request.body);
      const account = await requireWebUser(request, reply);
      if (!account) return;
      const payment = await getPaymentAdminSettings();
      if (input.payProvider === "wechat" && !payment.wechat.enabled) return reply.code(400).send({ ok: false, code: "PAYMENT_PROVIDER_DISABLED" });
      if (input.payProvider === "alipay" && !payment.alipay.enabled) return reply.code(400).send({ ok: false, code: "PAYMENT_PROVIDER_DISABLED" });
      const product = await fetchActiveProduct(input.productId);
      if (!product) return reply.code(404).send({ ok: false, code: "PRODUCT_NOT_FOUND" });
      const user = await db.selectFrom("users").selectAll().where("id", "=", account.userId).executeTakeFirst();
      if (!user || user.status !== "active") return reply.code(403).send({ ok: false, code: "USER_NOT_ACTIVE" });
      const order = {
        id: publicId("ord"),
        user_id: account.userId,
        product_id: product.id,
        provider: input.payProvider,
        amount_cents: product.price_cents,
        currency: product.currency || "CNY",
        status: "pending",
      };
      await db.insertInto("orders").values(order).execute();
      return reply.code(201).send({
        ok: true,
        order: {
          id: order.id,
          productId: product.id,
          provider: order.provider,
          amountCents: order.amount_cents,
          currency: order.currency,
          status: order.status,
        },
      });
    },
  );

  app.get(
    "/api/billing/orders",
    {
      schema: {
        tags: ["public:billing"],
        summary: "List current user's billing orders",
        response: { 200: okResponse({ orders: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      if (!clientFeatureEnabled(request, "purchase")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      const account = await requireWebUser(request, reply);
      if (!account) return;
      const orders = await db
        .selectFrom("orders")
        .leftJoin("products", "products.id", "orders.product_id")
        .select([
          "orders.id as id",
          "orders.product_id as product_id",
          "orders.provider as provider",
          "orders.provider_order_id as provider_order_id",
          "orders.amount_cents as amount_cents",
          "orders.currency as currency",
          "orders.status as status",
          "orders.paid_at as paid_at",
          "orders.created_at as created_at",
          "products.name as product_name",
          "products.resource_type as resource_type",
          "products.unit_amount as unit_amount",
        ])
        .where("orders.user_id", "=", account.userId)
        .orderBy("orders.created_at", "desc")
        .limit(50)
        .execute();
      const payment = await getPaymentAdminSettings();
      return {
        ok: true,
        fakePaymentsEnabled: Boolean(payment.fakePaymentsEnabled),
        orders: orders.map((order) => ({
          id: order.id,
          productId: order.product_id,
          productName: order.product_name || order.product_id,
          provider: order.provider,
          providerOrderId: order.provider_order_id || "",
          amountCents: Number(order.amount_cents || 0),
          currency: order.currency || "CNY",
          status: order.status,
          paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : "",
          createdAt: order.created_at ? new Date(order.created_at).toISOString() : "",
          resourceType: order.resource_type || "",
          unitAmount: Number(order.unit_amount || 0),
        })),
      };
    },
  );

  app.post(
    "/api/billing/orders/:orderId/mock-pay",
    {
      schema: {
        tags: ["public:billing"],
        summary: "Complete an order with fake website payment",
        response: { 200: okResponse({ grantId: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      if (!clientFeatureEnabled(request, "purchase")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      const payment = await getPaymentAdminSettings();
      if (!payment.fakePaymentsEnabled) return reply.code(404).send({ ok: false, code: "NOT_FOUND" });
      const account = await requireWebUser(request, reply);
      if (!account) return;
      const params = orderParamsSchema.parse(request.params);
      const order = await db.selectFrom("orders").selectAll().where("id", "=", params.orderId).executeTakeFirst();
      if (!order || order.user_id !== account.userId) return reply.code(404).send({ ok: false, code: "ORDER_NOT_FOUND" });
      const product = await db.selectFrom("products").selectAll().where("id", "=", order.product_id).executeTakeFirst();
      if (!product) return reply.code(404).send({ ok: false, code: "PRODUCT_NOT_FOUND" });
      const settled = await grantPaidOrder({
        order,
        product,
        providerOrderId: `fake_${publicId("pay")}`,
      });
      if (!settled.ok) return reply.code(400).send({ ok: false, code: settled.code });
      return settled;
    },
  );

  app.post(
    "/api/billing/dev-settle",
    {
      schema: {
        tags: ["public:billing"],
        summary: "Development-only settlement endpoint",
        body: zodBody(devSettleSchema),
        response: { 200: okResponse({ grantId: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      if (process.env.NODE_ENV === "production") return reply.code(404).send({ ok: false, code: "NOT_FOUND" });
      const input = devSettleSchema.parse(request.body);
      const order = await db.selectFrom("orders").selectAll().where("id", "=", input.orderId).executeTakeFirst();
      if (!order) return reply.code(404).send({ ok: false, code: "ORDER_NOT_FOUND" });
      const valid = validatePaymentNotification({ order, amountCents: input.amountCents, currency: input.currency });
      if (!valid.ok) return reply.code(400).send({ ok: false, code: valid.code });
      const product = await db.selectFrom("products").selectAll().where("id", "=", order.product_id).executeTakeFirst();
      if (!product) return reply.code(404).send({ ok: false, code: "PRODUCT_NOT_FOUND" });
      const settled = await grantPaidOrder({ order, product, providerOrderId: input.providerOrderId });
      if (!settled.ok) return reply.code(400).send({ ok: false, code: settled.code });
      return settled;
    },
  );
}
