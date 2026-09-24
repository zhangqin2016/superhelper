// What a user can see of their own money: every top-up, every refund, what
// their usage cost, and what is left and until when. Read-only views over the
// books the wallet already keeps (wallet_ledger, usage_events, wallet_grants,
// orders) — nothing here decides or changes a balance.

import { sql } from "kysely";
import { db as defaultDb } from "../db.js";

const RESOURCE_LABEL = { token: "Token", image_generation: "图片生成", video_generation: "视频生成", membership: "会员" };
const FEATURE_LABEL = { chat_model: "对话", image_generation: "图片生成", video_generation: "视频生成" };

function iso(value) {
  return value ? new Date(value).toISOString() : "";
}

/**
 * The user's statement, newest first, one line per money or credit movement.
 * Consumption that drew on several grants is one line (summed per usage event).
 * @param {{ before?: string, limit?: number, kind?: "all"|"topup"|"usage" }} q
 */
export async function userStatement(userId, { before = "", limit = 50, kind = "all" } = {}, db = defaultDb) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const cursor = before && Number.isFinite(Date.parse(before));
  const rows = await sql`
    select
      coalesce(l.source_type, '') || ':' || coalesce(l.source_id, l.id) as line_id,
      max(l.created_at) as at,
      to_char(max(l.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_key,
      min(l.event_type) as event_type,
      max(l.resource_type) as resource_type,
      sum(l.unit_delta)::bigint as units,
      sum(l.money_delta_cents)::bigint as money_cents,
      max(l.source_type) as source_type,
      max(l.source_id) as source_id,
      max(u.feature) as feature,
      max(u.model) as model,
      max(u.provider) as provider,
      max(u.input_tokens) as input_tokens,
      max(u.output_tokens) as output_tokens,
      max(p.name) as product_name,
      max(o.provider) as pay_provider,
      max(rf.order_id) as refund_order_id,
      bool_or(coalesce(l.metadata->>'duplicatePayment', '') = 'true') as duplicate_payment
    from wallet_ledger l
    left join usage_events u on l.source_type = 'usage' and u.id = l.source_id
    left join orders o on l.source_type = 'order' and o.id = l.source_id
    left join products p on p.id = o.product_id
    left join refunds rf on l.source_type = 'refund' and rf.id = l.source_id
    where l.user_id = ${userId}
      ${kind === "topup" ? sql`and l.event_type in ('grant', 'refund')` : kind === "usage" ? sql`and l.event_type = 'consume'` : sql``}
    group by line_id
    ${cursor ? sql`having max(l.created_at) < ${before}::timestamptz` : sql``}
    order by at desc
    limit ${cap + 1}
  `.execute(db);
  const lines = rows.rows.slice(0, cap).map((r) => ({
    id: r.line_id,
    at: iso(r.at),
    kind: r.event_type === "consume" ? "usage" : r.event_type === "refund" ? "refund" : r.source_type === "order" ? "topup" : "grant",
    title: r.event_type === "consume"
      ? `${FEATURE_LABEL[r.feature] || r.feature || "使用"}${r.model ? ` · ${r.model}` : ""}`
      : r.event_type === "refund" ? (r.duplicate_payment ? "重复支付退款" : "退款")
        : r.source_type === "order" ? `购买 ${r.product_name || ""}`.trim()
          : r.source_type === "signup" ? "新用户赠送" : "权益发放",
    resourceType: r.resource_type || "",
    resourceLabel: RESOURCE_LABEL[r.resource_type] || r.resource_type || "",
    units: Number(r.units || 0),
    moneyCents: Number(r.money_cents || 0),
    orderId: r.source_type === "order" ? r.source_id : r.refund_order_id || "",
    payProvider: r.pay_provider || "",
    ...(r.event_type === "consume" ? { inputTokens: Number(r.input_tokens || 0), outputTokens: Number(r.output_tokens || 0) } : {}),
  }));
  // The cursor is microsecond-exact (the ISO `at` is cut to milliseconds, and
  // paging on it could skip a line written in the same millisecond).
  return { lines, nextBefore: rows.rows.length > cap ? rows.rows[cap - 1].at_key : "" };
}

/** Usage per day and per feature/model over the last `days` (Beijing days). */
export async function userUsageSummary(userId, { days = 30 } = {}, db = defaultDb) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 180);
  const rows = await sql`
    select
      to_char(created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as day,
      coalesce(feature, '') as feature,
      coalesce(model, '') as model,
      coalesce(resource_type, '') as resource_type,
      count(*)::int as calls,
      sum(billable_units)::bigint as units
    from usage_events
    where user_id = ${userId} and created_at >= now() - make_interval(days => ${span}::int)
    group by 1, 2, 3, 4
    order by 1 desc, 6 desc
  `.execute(db);
  const byDay = new Map();
  const byModel = new Map();
  for (const r of rows.rows) {
    const units = Number(r.units || 0);
    const day = byDay.get(r.day) || { day: r.day, calls: 0, units: {} };
    day.calls += r.calls;
    day.units[r.resource_type] = (day.units[r.resource_type] || 0) + units;
    byDay.set(r.day, day);
    const key = `${r.feature}|${r.model}|${r.resource_type}`;
    const m = byModel.get(key) || { feature: r.feature, featureLabel: FEATURE_LABEL[r.feature] || r.feature, model: r.model, resourceType: r.resource_type, calls: 0, units: 0 };
    m.calls += r.calls;
    m.units += units;
    byModel.set(key, m);
  }
  return {
    days: span,
    byDay: [...byDay.values()],
    byModel: [...byModel.values()].sort((a, b) => b.units - a.units),
  };
}

/** What is left, grant by grant, soonest expiry first. */
export async function userBalanceDetail(userId, db = defaultDb) {
  const grants = await db.selectFrom("wallet_grants")
    .select(["id", "grant_type", "resource_type", "unit_total", "unit_remaining", "starts_at", "expires_at", "source_type", "status"])
    .where("user_id", "=", userId)
    .where("organization_id", "is", null)
    .where("status", "=", "active")
    .where("expires_at", ">", new Date())
    .orderBy("expires_at", "asc")
    .execute();
  return grants
    .filter((g) => g.resource_type === "membership" || Number(g.unit_remaining || 0) > 0)
    .map((g) => ({
      id: g.id,
      resourceType: g.resource_type,
      resourceLabel: RESOURCE_LABEL[g.resource_type] || g.resource_type,
      source: g.source_type === "order" ? "purchase" : g.source_type === "signup" ? "signup" : g.source_type || "",
      total: Number(g.unit_total || 0),
      remaining: Number(g.unit_remaining || 0),
      startsAt: iso(g.starts_at),
      expiresAt: iso(g.expires_at),
    }));
}
