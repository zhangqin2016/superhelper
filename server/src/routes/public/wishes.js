import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { publicId } from "../../services/ids.js";
import {
  PUBLIC_WISH_STATUSES,
  WISH_CATEGORIES,
  createWishActionLimiter,
  findSimilarWishes,
  normalizeWishInput,
  serializePublicWish,
  serializeSubmitterWish,
} from "../../services/feature-wishes.js";
import { requireWebUser, resolveWebUser } from "../../services/web-user-session.js";

const PUBLIC_STATUSES = [...PUBLIC_WISH_STATUSES];
const CATEGORIES = [...WISH_CATEGORIES];
const localeSchema = z.enum(["zh", "en", "ar"]).default("zh");
const wishIdSchema = z.object({ id: z.string().min(3).max(120) });
const listSchema = z.object({
  status: z.enum(PUBLIC_STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  sort: z.enum(["popular", "recent"]).default("popular"),
  locale: localeSchema,
});
const similarSchema = z.object({
  title: z.string().min(6).max(160),
  locale: localeSchema,
});
const createSchema = z.object({
  title: z.string().min(1).max(160),
  problem: z.string().min(1).max(2000),
  desiredOutcome: z.string().min(1).max(2000),
  category: z.enum(CATEGORIES).optional(),
});
const wishActionLimiter = createWishActionLimiter();

async function supportCounts(rows) {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return rows;
  const counts = await db
    .selectFrom("feature_wish_supporters")
    .select("wish_id")
    .select(({ fn }) => fn.count("user_id").as("support_count"))
    .where("wish_id", "in", ids)
    .groupBy("wish_id")
    .execute();
  const byId = new Map(counts.map((row) => [row.wish_id, Number(row.support_count || 0)]));
  return rows.map((row) => ({ ...row, support_count: byId.get(row.id) || 0 }));
}

async function publicWishRow(id) {
  return db
    .selectFrom("feature_wishes")
    .selectAll()
    .where("id", "=", id)
    .where("status", "in", PUBLIC_STATUSES)
    .executeTakeFirst();
}

function takeAction(reply, userId, action) {
  if (wishActionLimiter.take(userId, action)) return true;
  reply.code(429).send({ ok: false, code: "RATE_LIMITED" });
  return false;
}

export function registerPublicWishRoutes(app) {
  app.get("/api/wishes", {
    schema: {
      tags: ["public:wishes"],
      summary: "List approved public wishes",
      description: "Returns moderated wishes without submitter or private submission fields.",
      response: { 200: okResponse({ wishes: { type: "array", items: { type: "object" } } }) },
    },
  }, async (request) => {
    const input = listSchema.parse(request.query || {});
    let query = db
      .selectFrom("feature_wishes")
      .selectAll()
      .where("status", "in", input.status ? [input.status] : PUBLIC_STATUSES);
    if (input.category) query = query.where("category", "=", input.category);
    const rows = await supportCounts(await query.orderBy("updated_at", "desc").limit(200).execute());
    if (input.sort === "popular") {
      rows.sort((left, right) =>
        Number(right.support_count || 0) - Number(left.support_count || 0)
        || new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime());
    }
    return {
      ok: true,
      wishes: rows.slice(0, 100).map((row) => serializePublicWish(row, { locale: input.locale })).filter(Boolean),
    };
  });

  app.get("/api/wishes/:id", {
    schema: {
      tags: ["public:wishes"],
      summary: "Get a public wish or the current user's private wish",
      description: "Private wishes are visible only to their submitter.",
      response: { 200: okResponse({ wish: { type: "object" } }) },
    },
  }, async (request, reply) => {
    const { id } = wishIdSchema.parse(request.params || {});
    const row = await db.selectFrom("feature_wishes").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return reply.code(404).send({ ok: false, code: "WISH_NOT_FOUND" });
    const locale = localeSchema.parse(request.query?.locale || "zh");
    const publicWish = serializePublicWish(row, { locale });
    if (publicWish) return { ok: true, wish: publicWish };
    const account = await resolveWebUser(request);
    if (!account.ok || row.submitter_user_id !== account.userId) {
      return reply.code(404).send({ ok: false, code: "WISH_NOT_FOUND" });
    }
    return { ok: true, wish: serializeSubmitterWish(row) };
  });

  app.post("/api/wishes/similar", {
    schema: {
      tags: ["public:wishes"],
      summary: "Find similar approved wishes",
      description: "Helps a logged-in user support an existing wish before creating a duplicate.",
      body: zodBody(similarSchema),
      response: { 200: okResponse({ wishes: { type: "array", items: { type: "object" } } }) },
    },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return reply;
    if (!takeAction(reply, account.userId, "similar")) return reply;
    const input = similarSchema.parse(request.body || {});
    const rows = await supportCounts(await db
      .selectFrom("feature_wishes")
      .selectAll()
      .where("status", "in", PUBLIC_STATUSES)
      .orderBy("updated_at", "desc")
      .limit(300)
      .execute());
    const wishes = findSimilarWishes(input.title, rows)
      .map((row) => {
        const wish = serializePublicWish(row, { locale: input.locale });
        return wish ? { ...wish, similarity: Number(row.score.toFixed(3)) } : null;
      })
      .filter(Boolean);
    return { ok: true, wishes };
  });

  app.post("/api/wishes", {
    schema: {
      tags: ["public:wishes"],
      summary: "Submit a private wish for moderation",
      description: "Creates a pending wish owned by the logged-in user; it is never published automatically.",
      body: zodBody(createSchema),
      response: { 201: okResponse({ id: { type: "string" }, status: { type: "string" } }) },
    },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return reply;
    if (!takeAction(reply, account.userId, "create")) return reply;
    const normalized = normalizeWishInput(createSchema.parse(request.body || {}));
    if (!normalized.ok) return reply.code(400).send({ ok: false, code: normalized.code });
    const id = publicId("wish");
    await db.insertInto("feature_wishes").values({
      id,
      submitter_user_id: account.userId,
      title: normalized.value.title,
      problem: normalized.value.problem,
      desired_outcome: normalized.value.desiredOutcome,
      category: normalized.value.category,
      status: "pending",
    }).execute();
    return reply.code(201).send({ ok: true, id, status: "pending" });
  });

  app.post("/api/wishes/:id/support", {
    schema: {
      tags: ["public:wishes"],
      summary: "Support an approved wish",
      description: "Idempotently records that the logged-in user also needs this outcome.",
      response: { 200: okResponse({ supported: { type: "boolean" } }) },
    },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return reply;
    if (!takeAction(reply, account.userId, "support")) return reply;
    const { id } = wishIdSchema.parse(request.params || {});
    if (!(await publicWishRow(id))) return reply.code(404).send({ ok: false, code: "WISH_NOT_FOUND" });
    await db.insertInto("feature_wish_supporters")
      .values({ wish_id: id, user_id: account.userId })
      .onConflict((conflict) => conflict.columns(["wish_id", "user_id"]).doNothing())
      .execute();
    return { ok: true, supported: true };
  });

  app.delete("/api/wishes/:id/support", {
    schema: {
      tags: ["public:wishes"],
      summary: "Remove support from an approved wish",
      description: "Removes only the logged-in user's support record.",
      response: { 200: okResponse({ supported: { type: "boolean" } }) },
    },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return reply;
    if (!takeAction(reply, account.userId, "support")) return reply;
    const { id } = wishIdSchema.parse(request.params || {});
    await db.deleteFrom("feature_wish_supporters")
      .where("wish_id", "=", id)
      .where("user_id", "=", account.userId)
      .execute();
    return { ok: true, supported: false };
  });

  app.get("/api/account/wishes", {
    schema: {
      tags: ["public:wishes"],
      summary: "List the current user's wish submissions",
      description: "Returns private status and submitter notes only for the authenticated account.",
      response: { 200: okResponse({ wishes: { type: "array", items: { type: "object" } } }) },
    },
  }, async (request, reply) => {
    const account = await requireWebUser(request, reply);
    if (!account) return reply;
    const rows = await db.selectFrom("feature_wishes")
      .selectAll()
      .where("submitter_user_id", "=", account.userId)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    return { ok: true, wishes: rows.map(serializeSubmitterWish) };
  });
}
