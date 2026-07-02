import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";

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
}
