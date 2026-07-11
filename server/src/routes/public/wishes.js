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

async function attachViewerSupport(rows, userId, database = db) {
  if (!userId || rows.length === 0) return rows.map((row) => ({ ...row, viewer_supported: false }));
  const supported = await database.selectFrom("feature_wish_supporters")
    .select("wish_id")
    .where("user_id", "=", userId)
    .where("wish_id", "in", rows.map((row) => row.id))
    .execute();
  const ids = new Set(supported.map((row) => row.wish_id));
  return rows.map((row) => ({ ...row, viewer_supported: ids.has(row.id) }));
}

async function validPublicOutcomeRows(rows, database = db) {
  const shipped = rows.filter((row) => row.status === "shipped");
  if (shipped.length === 0) return rows;
  const appIds = [...new Set(shipped.flatMap((row) => Array.isArray(row.linked_app_ids) ? row.linked_app_ids : []))];
  const skillIds = [...new Set(shipped.flatMap((row) => Array.isArray(row.linked_skill_ids) ? row.linked_skill_ids : []))];
  const [apps, skills] = await Promise.all([
    appIds.length ? database.selectFrom("workspace_apps").select("app_id")
      .where("app_id", "in", appIds).where("enabled", "=", true).execute() : [],
    skillIds.length ? database.selectFrom("skill_packages").select("skill_id")
      .where("skill_id", "in", skillIds).where("enabled", "=", true)
      .where("display_in_catalog", "=", true).execute() : [],
  ]);
  const validApps = new Set(apps.map((row) => row.app_id));
  const validSkills = new Set(skills.map((row) => row.skill_id));
  return rows.map((row) => row.status !== "shipped" ? row : ({
    ...row,
    linked_app_ids: (Array.isArray(row.linked_app_ids) ? row.linked_app_ids : []).filter((id) => validApps.has(id)),
    linked_skill_ids: (Array.isArray(row.linked_skill_ids) ? row.linked_skill_ids : []).filter((id) => validSkills.has(id)),
  }));
}

async function popularWishRows(input) {
  let query = db.selectFrom("feature_wishes as wishes")
    .leftJoin("feature_wish_supporters as supporters", "supporters.wish_id", "wishes.id")
    .selectAll("wishes")
    .select(({ fn }) => fn.count("supporters.user_id").as("support_count"))
    .where("wishes.status", "in", input.status ? [input.status] : PUBLIC_STATUSES);
  if (input.category) query = query.where("wishes.category", "=", input.category);
  return query.groupBy("wishes.id")
    .orderBy("support_count", "desc")
    .orderBy("wishes.updated_at", "desc")
    .limit(100)
    .execute();
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
    const account = await resolveWebUser(request);
    let rows;
    if (input.sort === "popular") {
      rows = await popularWishRows(input);
    } else {
      let query = db.selectFrom("feature_wishes").selectAll()
        .where("status", "in", input.status ? [input.status] : PUBLIC_STATUSES);
      if (input.category) query = query.where("category", "=", input.category);
      rows = await supportCounts(await query.orderBy("updated_at", "desc").limit(100).execute());
    }
    rows = await attachViewerSupport(await validPublicOutcomeRows(rows), account.ok ? account.userId : null);
    return {
      ok: true,
      wishes: rows.map((row) => serializePublicWish(row, { locale: input.locale })).filter(Boolean),
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
    const account = await resolveWebUser(request);
    const [publicRow] = await attachViewerSupport(await validPublicOutcomeRows([row]), account.ok ? account.userId : null);
    const publicWish = serializePublicWish(publicRow, { locale });
    if (publicWish) return { ok: true, wish: publicWish };
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
    let rows = await supportCounts(await db
      .selectFrom("feature_wishes")
      .selectAll()
      .where("status", "in", PUBLIC_STATUSES)
      .orderBy("updated_at", "desc")
      .limit(300)
      .execute());
    rows = await attachViewerSupport(await validPublicOutcomeRows(rows), account.userId);
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
    const supported = await db.transaction().execute(async (trx) => {
      const wish = await trx.selectFrom("feature_wishes").select("id")
        .where("id", "=", id).where("status", "in", PUBLIC_STATUSES)
        .forUpdate().executeTakeFirst();
      if (!wish) return false;
      await trx.insertInto("feature_wish_supporters")
        .values({ wish_id: id, user_id: account.userId })
        .onConflict((conflict) => conflict.columns(["wish_id", "user_id"]).doNothing())
        .execute();
      return true;
    });
    if (!supported) return reply.code(404).send({ ok: false, code: "WISH_NOT_FOUND" });
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
    const removed = await db.transaction().execute(async (trx) => {
      const wish = await trx.selectFrom("feature_wishes").select("id")
        .where("id", "=", id).where("status", "in", PUBLIC_STATUSES)
        .forUpdate().executeTakeFirst();
      if (!wish) return false;
      await trx.deleteFrom("feature_wish_supporters")
        .where("wish_id", "=", id)
        .where("user_id", "=", account.userId)
        .execute();
      return true;
    });
    if (!removed) return reply.code(404).send({ ok: false, code: "WISH_NOT_FOUND" });
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
