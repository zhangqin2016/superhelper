import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import {
  PUBLIC_WISH_STATUSES,
  WISH_CATEGORIES,
  validateWishAdminUpdate,
} from "../../services/feature-wishes.js";

const ALL_STATUSES = ["pending", "reviewing", "published", "planned", "building", "shipped", "declined", "merged"];
const PATCH_STATUSES = ALL_STATUSES.filter((status) => status !== "merged");
const idSchema = z.object({ id: z.string().min(3).max(120) });
const listSchema = z.object({
  status: z.enum(ALL_STATUSES).optional(),
  category: z.enum([...WISH_CATEGORIES]).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(200),
});
const patchSchema = z.object({
  publicTitle: z.string().max(160).optional().nullable(),
  publicTitleI18n: z.record(z.string(), z.string().max(160)).optional(),
  publicSummary: z.string().max(1000).optional().nullable(),
  publicSummaryI18n: z.record(z.string(), z.string().max(1000)).optional(),
  publicUpdate: z.string().max(1000).optional().nullable(),
  publicUpdateI18n: z.record(z.string(), z.string().max(1000)).optional(),
  submitterStatusNote: z.string().max(1000).optional().nullable(),
  category: z.enum([...WISH_CATEGORIES]).optional(),
  status: z.enum(PATCH_STATUSES).optional(),
  linkedAppIds: z.array(z.string().min(2).max(120)).max(30).optional(),
  linkedSkillIds: z.array(z.string().min(2).max(120)).max(30).optional(),
});
const mergeSchema = z.object({ targetWishId: z.string().min(3).max(120) });

async function attachSupportCounts(rows) {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return rows;
  const counts = await db.selectFrom("feature_wish_supporters")
    .select("wish_id")
    .select(({ fn }) => fn.count("user_id").as("support_count"))
    .where("wish_id", "in", ids)
    .groupBy("wish_id")
    .execute();
  const byId = new Map(counts.map((row) => [row.wish_id, Number(row.support_count || 0)]));
  return rows.map((row) => ({ ...row, support_count: byId.get(row.id) || 0 }));
}

async function validOutcomeIds(database, appIds, skillIds) {
  const apps = appIds.length
    ? await database.selectFrom("workspace_apps").select("app_id")
      .where("app_id", "in", appIds).where("enabled", "=", true).execute()
    : [];
  const skills = skillIds.length
    ? await database.selectFrom("skill_packages").select("skill_id")
      .where("skill_id", "in", skillIds)
      .where("enabled", "=", true)
      .where("display_in_catalog", "=", true)
      .execute()
    : [];
  return {
    validAppIds: [...new Set(apps.map((row) => row.app_id))],
    validSkillIds: [...new Set(skills.map((row) => row.skill_id))],
  };
}

export function registerAdminWishRoutes(app, { audit }) {
  app.get("/api/admin/wishes", {
    schema: {
      tags: ["admin:wishes"],
      summary: "List wishes for moderation",
      description: "Returns private submissions and public wishes to authenticated administrators.",
      response: { 200: okResponse({ wishes: { type: "array", items: { type: "object" } } }) },
    },
  }, async (request) => {
    const input = listSchema.parse(request.query || {});
    let query = db.selectFrom("feature_wishes").selectAll();
    if (input.status) query = query.where("status", "=", input.status);
    if (input.category) query = query.where("category", "=", input.category);
    const wishes = await attachSupportCounts(await query
      .orderBy("updated_at", "desc")
      .limit(input.limit)
      .execute());
    return { ok: true, wishes };
  });

  app.get("/api/admin/wishes/:id", {
    schema: {
      tags: ["admin:wishes"],
      summary: "Get a wish for moderation",
      description: "Returns the complete wish submission plus exact support count.",
      response: { 200: okResponse({ wish: { type: "object" } }) },
    },
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params || {});
    const row = await db.selectFrom("feature_wishes").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return reply.code(404).send({ ok: false, code: "WISH_NOT_FOUND" });
    const [wish] = await attachSupportCounts([row]);
    return { ok: true, wish };
  });

  app.patch("/api/admin/wishes/:id", {
    schema: {
      tags: ["admin:wishes"],
      summary: "Review or update a wish",
      description: "Applies validated status, public copy, and shipped outcome links.",
      body: zodBody(patchSchema),
      response: { 200: okResponse({ wish: { type: "object" } }) },
    },
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params || {});
    const input = patchSchema.parse(request.body || {});
    const result = await db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("feature_wishes").selectAll()
        .where("id", "=", id).forUpdate().executeTakeFirst();
      if (!current) return { ok: false, code: "WISH_NOT_FOUND", statusCode: 404 };
      const requestedAppIds = input.linkedAppIds ?? (Array.isArray(current.linked_app_ids) ? current.linked_app_ids : []);
      const requestedSkillIds = input.linkedSkillIds ?? (Array.isArray(current.linked_skill_ids) ? current.linked_skill_ids : []);
      const validIds = await validOutcomeIds(trx, requestedAppIds, requestedSkillIds);
      const checked = validateWishAdminUpdate(current, input, validIds);
      if (!checked.ok) return { ...checked, statusCode: 400 };
      const now = new Date();
      const publishedAt = PUBLIC_WISH_STATUSES.has(checked.value.status)
        ? (current.published_at || now)
        : current.published_at;
      const wish = await trx.updateTable("feature_wishes")
        .set({ ...checked.value, published_at: publishedAt, updated_at: now })
        .where("id", "=", id)
        .where("status", "=", current.status)
        .returningAll()
        .executeTakeFirst();
      if (!wish) return { ok: false, code: "WISH_CONCURRENT_UPDATE", statusCode: 409 };
      return { ok: true, current, checked, wish };
    });
    if (!result.ok) return reply.code(result.statusCode).send({ ok: false, code: result.code });
    const { current, checked, wish } = result;
    await audit(request, "wish.update", "feature_wish", id, {
      fromStatus: current.status,
      toStatus: wish.status,
      linkedAppIds: checked.value.linked_app_ids,
      linkedSkillIds: checked.value.linked_skill_ids,
    });
    return { ok: true, wish };
  });

  app.post("/api/admin/wishes/:id/merge", {
    schema: {
      tags: ["admin:wishes"],
      summary: "Merge a duplicate wish",
      description: "Moves unique supporters to the target wish and marks the source merged in one transaction.",
      body: zodBody(mergeSchema),
      response: { 200: okResponse({ sourceId: { type: "string" }, targetId: { type: "string" } }) },
    },
  }, async (request, reply) => {
    const { id: sourceId } = idSchema.parse(request.params || {});
    const { targetWishId: targetId } = mergeSchema.parse(request.body || {});
    if (sourceId === targetId) return reply.code(400).send({ ok: false, code: "WISH_MERGE_SELF" });

    const merged = await db.transaction().execute(async (trx) => {
      const source = await trx.selectFrom("feature_wishes").selectAll()
        .where("id", "=", sourceId).forUpdate().executeTakeFirst();
      const target = await trx.selectFrom("feature_wishes").selectAll()
        .where("id", "=", targetId).forUpdate().executeTakeFirst();
      if (!source || !target) return { ok: false, code: "WISH_NOT_FOUND" };
      if (source.status === "merged" || !PUBLIC_WISH_STATUSES.has(target.status)) {
        return { ok: false, code: "WISH_MERGE_INVALID" };
      }

      const supporters = await trx.selectFrom("feature_wish_supporters")
        .select("user_id").where("wish_id", "=", sourceId).execute();
      if (supporters.length) {
        await trx.insertInto("feature_wish_supporters")
          .values(supporters.map((row) => ({ wish_id: targetId, user_id: row.user_id })))
          .onConflict((conflict) => conflict.columns(["wish_id", "user_id"]).doNothing())
          .execute();
      }
      await trx.deleteFrom("feature_wish_supporters").where("wish_id", "=", sourceId).execute();
      await trx.updateTable("feature_wishes").set({
        status: "merged",
        merged_into_id: targetId,
        submitter_status_note: `已合并到愿望 ${targetId}`,
        updated_at: new Date(),
      }).where("id", "=", sourceId).execute();
      await trx.updateTable("feature_wishes").set({ updated_at: new Date() })
        .where("id", "=", targetId).execute();
      return { ok: true };
    });
    if (!merged.ok) return reply.code(400).send(merged);
    await audit(request, "wish.merge", "feature_wish", sourceId, { targetId });
    return { ok: true, sourceId, targetId };
  });
}
