// Personal Pro/Max plans on top of the wallet: the plan's weeks, the weekly
// allowance handed out once per week, the plan a user holds, and whether they
// may use their own model keys. Split out of wallet.js (size ratchet).

import { sql } from "kysely";
import { publicId } from "./ids.js";

export const PLAN_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The allowance week a subscription is in at `now`. Weeks count from the
 * start of the paid period (like a weekly usage limit), the last one is cut
 * at the period's end. Pure.
 */
export function planWeek({ startsAt, expiresAt, now = new Date() }) {
  const start = new Date(startsAt).getTime();
  const end = new Date(expiresAt).getTime();
  const at = new Date(now).getTime();
  if (!(at >= start && at < end)) return null;
  const index = Math.floor((at - start) / PLAN_WEEK_MS);
  const weekStart = start + index * PLAN_WEEK_MS;
  return { index, startsAt: new Date(weekStart), expiresAt: new Date(Math.min(weekStart + PLAN_WEEK_MS, end)) };
}

/**
 * Hand out this week's allowance of every active plan the user holds — once per
 * plan per week, whoever asks first (a charge, or reading the balance). The
 * allowance is an ordinary token grant that expires when the week ends, so
 * "resets weekly, never accumulates" is the existing expiry, and every
 * existing view (balance, statement, admin) already shows it.
 */
export async function ensurePlanAllowances(trx, userId, now = new Date()) {
  const plans = await trx.selectFrom("wallet_grants").selectAll()
    .where("user_id", "=", userId).where("resource_type", "=", "plan").where("status", "=", "active")
    .where("organization_id", "is", null).where("starts_at", "<=", now).where("expires_at", ">", now)
    .where("unit_total", ">", 0)
    .execute();
  for (const plan of plans) {
    const week = planWeek({ startsAt: plan.starts_at, expiresAt: plan.expires_at, now });
    if (!week) continue;
    const key = `plan_week:${plan.id}:${week.index}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    const issued = await trx.selectFrom("wallet_ledger").select("id").where("idempotency_key", "=", key).executeTakeFirst();
    if (issued) continue;
    const grantId = publicId("grant");
    const units = Number(plan.unit_total || 0);
    const tier = plan.metadata?.plan || "";
    await trx.insertInto("wallet_grants").values({
      id: grantId, user_id: userId, source_type: "plan", source_id: plan.id, grant_type: "plan_weekly",
      resource_type: "token", token_total: units, token_remaining: units, unit_total: units, unit_remaining: units,
      starts_at: week.startsAt, expires_at: week.expiresAt, status: "active",
      metadata: { plan: tier, planGrantId: plan.id, week: week.index },
    }).execute();
    await trx.insertInto("wallet_ledger").values({
      id: publicId("ledger"), user_id: userId, grant_id: grantId, event_type: "grant", resource_type: "token",
      token_delta: units, unit_delta: units, source_type: "plan", source_id: plan.id,
      idempotency_key: key, metadata: { plan: tier, week: week.index },
    }).execute();
  }
}

/** The plan a user holds now (the longest-running active one), or null. */
export function activePlanOf(grants = [], now = new Date()) {
  const at = new Date(now).getTime();
  let best = null;
  for (const grant of grants) {
    if (grant?.resource_type !== "plan" || grant.status !== "active") continue;
    const start = new Date(grant.starts_at).getTime();
    const end = new Date(grant.expires_at).getTime();
    if (!(start <= at && end > at)) continue;
    if (!best || end > new Date(best.expires_at).getTime()) best = grant;
  }
  if (!best) return null;
  // A renewal starts where the current period ends: follow the chain of
  // back-to-back periods of the same tier to the real end of the subscription.
  const tier = best.metadata?.plan || "";
  let end = new Date(best.expires_at).getTime();
  const next = grants.filter((grant) => grant?.resource_type === "plan" && grant.status === "active" && (grant.metadata?.plan || "") === tier)
    .sort((x, y) => new Date(x.starts_at) - new Date(y.starts_at));
  for (const grant of next) {
    const start = new Date(grant.starts_at).getTime();
    if (start <= end + 1000) end = Math.max(end, new Date(grant.expires_at).getTime());
  }
  return { tier, expiresAt: new Date(end).toISOString(), weeklyUnits: Number(best.unit_total || 0) };
}

/**
 * Whether this user may use their own model keys. Off by default (the admin
 * setting `byok_requires_plan`); when on, a Pro/Max plan, or an active
 * enterprise membership, allows it.
 */
export async function byokAllowedFor(userId, grants, trx) {
  const row = await trx.selectFrom("app_settings").select("value").where("key", "=", "byok_requires_plan").executeTakeFirst();
  let required = row?.value;
  if (typeof required === "string") { try { required = JSON.parse(required); } catch { /* bare */ } }
  if (required !== true) return { allowed: true, reason: "open" };
  const plan = activePlanOf(grants);
  if (plan && ["pro", "max"].includes(plan.tier)) return { allowed: true, reason: "plan" };
  const member = await trx.selectFrom("organization_members")
    .innerJoin("organizations", "organizations.id", "organization_members.organization_id")
    .select("organization_members.user_id")
    .where("organization_members.user_id", "=", userId).where("organization_members.status", "=", "active")
    .where("organizations.status", "=", "active").executeTakeFirst();
  if (member) return { allowed: true, reason: "organization" };
  return { allowed: false, reason: "plan_required" };
}
