import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";
import { paymentService } from "../../services/payments/service.js";

const productSchema = z.object({
  id: z.string().min(2).max(120),
  kind: z.enum(["day_pass", "week_pass", "month_pass", "token_pack", "image_pack", "video_pack", "single_use"]),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional().nullable(),
  priceCents: z.number().int().min(0).max(10_000_000),
  currency: z.string().min(3).max(8).default("CNY"),
  resourceType: z.enum(["token", "image_generation", "video_generation", "membership"]),
  unitAmount: z.number().int().min(0).max(1_000_000_000).default(0),
  durationSeconds: z.number().int().min(0).max(10 * 365 * 24 * 60 * 60).optional().nullable(),
  grantExpiresDays: z.number().int().min(0).max(3650).optional().nullable(),
  metadata: z.record(z.any()).optional().default({}),
  status: z.enum(["active", "disabled"]).default("active"),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
});

const pricingRuleSchema = z.object({
  id: z.string().min(2).max(120),
  feature: z.enum(["chat_model", "image_generation", "video_generation"]),
  provider: z.string().max(80).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  specKey: z.string().min(1).max(120),
  resourceType: z.enum(["token", "image_generation", "video_generation", "membership"]),
  unitCost: z.number().int().min(0).max(1_000_000).default(1),
  freeDailyLimit: z.number().int().min(0).max(1_000_000).optional().nullable(),
  paidDailyLimit: z.number().int().min(0).max(1_000_000).optional().nullable(),
  concurrencyLimit: z.number().int().min(0).max(1000).optional().nullable(),
  enabled: z.boolean().default(true),
  metadata: z.record(z.any()).optional().default({}),
});

export function registerAdminBillingRoutes(app, { audit }) {
  app.get(
    "/api/admin/billing/products",
    {
      schema: {
        tags: ["admin:billing"],
        summary: "List billing products",
        response: { 200: okResponse({ products: { type: "array" } }) },
      },
    },
    async () => ({
      ok: true,
      products: await db.selectFrom("products").selectAll().orderBy("sort_order", "asc").orderBy("created_at", "desc").execute(),
    }),
  );

  app.post(
    "/api/admin/billing/products",
    {
      schema: {
        tags: ["admin:billing"],
        summary: "Create or update a billing product",
        body: zodBody(productSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
      const input = productSchema.parse(request.body);
      await db
        .insertInto("products")
        .values({
          id: input.id,
          kind: input.kind,
          name: input.name,
          description: input.description || null,
          price_cents: input.priceCents,
          currency: input.currency,
          resource_type: input.resourceType,
          unit_amount: input.unitAmount,
          duration_seconds: input.durationSeconds || null,
          grant_expires_days: input.grantExpiresDays || null,
          metadata: input.metadata,
          status: input.status,
          sort_order: input.sortOrder,
          updated_at: new Date(),
        })
        .onConflict((oc) => oc.column("id").doUpdateSet({
          kind: input.kind,
          name: input.name,
          description: input.description || null,
          price_cents: input.priceCents,
          currency: input.currency,
          resource_type: input.resourceType,
          unit_amount: input.unitAmount,
          duration_seconds: input.durationSeconds || null,
          grant_expires_days: input.grantExpiresDays || null,
          metadata: input.metadata,
          status: input.status,
          sort_order: input.sortOrder,
          updated_at: new Date(),
        }))
        .execute();
      await audit(request, "billing_product.upsert", "billing_product", input.id, { priceCents: input.priceCents, status: input.status });
      return { ok: true, id: input.id };
    },
  );

  app.get(
    "/api/admin/billing/pricing-rules",
    {
      schema: {
        tags: ["admin:billing"],
        summary: "List feature pricing rules",
        response: { 200: okResponse({ rules: { type: "array" } }) },
      },
    },
    async () => ({
      ok: true,
      rules: await db.selectFrom("feature_pricing_rules").selectAll().orderBy("feature", "asc").orderBy("spec_key", "asc").execute(),
    }),
  );

  app.post(
    "/api/admin/billing/pricing-rules",
    {
      schema: {
        tags: ["admin:billing"],
        summary: "Create or update a feature pricing rule",
        body: zodBody(pricingRuleSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
      const input = pricingRuleSchema.parse(request.body);
      await db
        .insertInto("feature_pricing_rules")
        .values({
          id: input.id,
          feature: input.feature,
          provider: input.provider || null,
          model: input.model || null,
          spec_key: input.specKey,
          resource_type: input.resourceType,
          unit_cost: input.unitCost,
          free_daily_limit: input.freeDailyLimit ?? null,
          paid_daily_limit: input.paidDailyLimit ?? null,
          concurrency_limit: input.concurrencyLimit ?? null,
          enabled: input.enabled,
          metadata: input.metadata,
          updated_at: new Date(),
        })
        .onConflict((oc) => oc.column("id").doUpdateSet({
          feature: input.feature,
          provider: input.provider || null,
          model: input.model || null,
          spec_key: input.specKey,
          resource_type: input.resourceType,
          unit_cost: input.unitCost,
          free_daily_limit: input.freeDailyLimit ?? null,
          paid_daily_limit: input.paidDailyLimit ?? null,
          concurrency_limit: input.concurrencyLimit ?? null,
          enabled: input.enabled,
          metadata: input.metadata,
          updated_at: new Date(),
        }))
        .execute();
      await audit(request, "feature_pricing_rule.upsert", "feature_pricing_rule", input.id, { unitCost: input.unitCost, enabled: input.enabled });
      return { ok: true, id: input.id };
    },
  );

  // --- orders, payments, refunds, reconciliation ---------------------------------

  const payments = paymentService();
  const orderListQuery = pageQuerySchema.extend({
    status: z.enum(["all", "pending", "paid", "closed", "partially_refunded", "refunded"]).optional().default("all"),
    q: z.string().max(120).optional().default(""),
  });
  const orderParams = z.object({ id: z.string().min(3).max(120) });
  const refundSchema = z.object({ amountCents: z.number().int().min(1).optional(), reason: z.string().min(1).max(200) });
  const reconcileSchema = z.object({ provider: z.enum(["alipay", "wechat"]), billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

  app.get("/api/admin/billing/orders", {
    schema: { tags: ["admin:billing"], summary: "List orders (filter by status, search order id / phone / trade number)", querystring: zodBody(orderListQuery), response: { 200: okResponse({ ...pageResponseSchema("orders"), counts: { type: "object", additionalProperties: { type: "number" } } }) } },
  }, async (request) => {
    const { status, q } = orderListQuery.parse(request.query || {});
    const scoped = (builder) => {
      let b = status === "all" ? builder : builder.where("orders.status", "=", status);
      const term = q.trim();
      if (term) {
        b = b.where((eb) => eb.or([
          eb("orders.id", "=", term),
          eb("orders.provider_order_id", "=", term),
          eb("users.phone_e164", "like", `%${term.replace(/[%_]/g, "")}%`),
          eb.exists(eb.selectFrom("payments").select("payments.id").whereRef("payments.order_id", "=", "orders.id").where((p) => p.or([p("payments.id", "=", term), p("payments.provider_trade_no", "=", term)]))),
        ]));
      }
      return b;
    };
    const base = () => db.selectFrom("orders").leftJoin("users", "users.id", "orders.user_id").leftJoin("products", "products.id", "orders.product_id");
    const page = await listPage(request, {
      key: "orders",
      query: () => scoped(base()).selectAll("orders").select(["users.phone_e164 as phone", "products.name as product_name"]),
      countQuery: () => scoped(base()).select((eb) => eb.fn.count("orders.id").as("count")),
      sortColumn: "orders.created_at",
      idColumn: "orders.id",
    });
    const countRows = await db.selectFrom("orders").select(["status", sql`count(*)::int`.as("n")]).groupBy("status").execute();
    return { ...page, counts: Object.fromEntries(countRows.map((r) => [r.status, Number(r.n)])) };
  });

  app.get("/api/admin/billing/orders/:id", {
    schema: { tags: ["admin:billing"], summary: "One order with its payment attempts, provider events, refunds and grant", response: { 200: okResponse({ order: { type: "object", additionalProperties: true } }) } },
  }, async (request, reply) => {
    const { id } = orderParams.parse(request.params);
    const order = await db.selectFrom("orders").leftJoin("users", "users.id", "orders.user_id").leftJoin("products", "products.id", "orders.product_id")
      .selectAll("orders").select(["users.phone_e164 as phone", "products.name as product_name", "products.resource_type as resource_type", "products.unit_amount as unit_amount"])
      .where("orders.id", "=", id).executeTakeFirst();
    if (!order) return reply.code(404).send({ ok: false, code: "ORDER_NOT_FOUND" });
    const attempts = await db.selectFrom("payments").selectAll().where("order_id", "=", id).orderBy("created_at", "asc").execute();
    const events = attempts.length
      ? await db.selectFrom("payment_events").selectAll().where("payment_id", "in", attempts.map((p) => p.id)).orderBy("created_at", "desc").limit(100).execute()
      : [];
    const refunds = await db.selectFrom("refunds").selectAll().where("order_id", "=", id).orderBy("created_at", "desc").execute();
    const grants = await db.selectFrom("wallet_grants").selectAll().where("source_type", "=", "order").where("source_id", "=", id).execute();
    return { ok: true, order: { ...order, payments: attempts, events, refunds, grants } };
  });

  app.post("/api/admin/billing/orders/:id/sync", {
    schema: { tags: ["admin:billing"], summary: "Ask the provider about this order's payments now", response: { 200: okResponse({ results: { type: "array" } }) } },
  }, async (request) => {
    const { id } = orderParams.parse(request.params);
    const result = await payments.syncOrderNow(id);
    await audit(request, "billing_order.sync", "order", id, { results: result.results.map((r) => r.outcome) });
    return result;
  });

  app.post("/api/admin/billing/orders/:id/refund", {
    schema: { tags: ["admin:billing"], summary: "Refund a paid order (all or part); the credit is taken back in proportion", body: zodBody(refundSchema), response: { 200: okResponse({ refundId: { type: "string" }, status: { type: "string" } }) } },
  }, async (request, reply) => {
    const { id } = orderParams.parse(request.params);
    const input = refundSchema.parse(request.body);
    const result = await payments.refund({ orderId: id, amountCents: input.amountCents, reason: input.reason, actor: "admin" });
    await audit(request, "billing_order.refund", "order", id, { amountCents: input.amountCents ?? null, ok: result.ok, code: result.code || null, refundId: result.refundId || null });
    if (!result.ok) return reply.code(result.status || 400).send({ ok: false, code: result.code, refundId: result.refundId || null });
    return { ok: true, refundId: result.refundId, status: result.status };
  });

  app.get("/api/admin/billing/reconciliation", {
    schema: { tags: ["admin:billing"], summary: "Recent statement reconciliations", response: { 200: okResponse({ runs: { type: "array" } }) } },
  }, async () => ({
    ok: true,
    runs: await db.selectFrom("reconciliation_runs").selectAll().orderBy("bill_date", "desc").orderBy("provider", "asc").limit(60).execute(),
  }));

  app.post("/api/admin/billing/reconciliation", {
    schema: { tags: ["admin:billing"], summary: "Reconcile one day's provider statement now", body: zodBody(reconcileSchema), response: { 200: okResponse({ status: { type: "string" } }) } },
  }, async (request, reply) => {
    const input = reconcileSchema.parse(request.body);
    const result = await payments.reconcile(input.provider, input.billDate);
    await audit(request, "billing.reconcile", "reconciliation", `${input.provider}:${input.billDate}`, { ok: result.ok, status: result.status || result.code });
    if (!result.ok) return reply.code(502).send({ ok: false, code: result.code });
    return result;
  });

  app.get("/api/admin/billing/payment-events", {
    schema: { tags: ["admin:billing"], summary: "Payment events needing attention (rejected / errors)", response: { 200: okResponse({ events: { type: "array" } }) } },
  }, async () => ({
    ok: true,
    events: await db.selectFrom("payment_events").selectAll().where("outcome", "in", ["rejected", "error", "double_paid", "unknown_payment"]).orderBy("created_at", "desc").limit(100).execute(),
  }));
}
