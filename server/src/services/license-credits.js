// Licence codes (授权码) as plans with a weekly credit pool (2026-09-30).
//
// A licence opens a plan; its pool each week is credits-per-seat × seats in
// use — active bound devices, capped by the licence's `seats`, at least 1 — so
// an over-typed seat count (99999) cannot make the pool bottomless. Weeks count
// from the licence's creation and reset every 7 days, like the personal plans.
// Licensed devices spend this pool first; when it is used up the signed-in
// account's own credits pay, and a device with no account waits for the reset.

import { sql } from "kysely";
import { publicId } from "./ids.js";

export const LICENSE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Credits per seat per week, from the quote sheet's prices at the same
// credits-per-yuan as Pro (¥49 → 10,000) and Max (¥99 → 22,000).
export const LICENSE_PLAN_WEEKLY_CREDITS = Object.freeze({
  trial: 10000,
  pro: 10000,
  max: 22000,
  standard: 12000,
  premium: 28000,
});
// "Unlimited" (不限量): never refused for credits, but every request is still
// metered and recorded, so what the licence really costs stays visible.
export const UNLIMITED_PLAN = "unlimited";
export const LICENSE_PLANS = Object.freeze([...Object.keys(LICENSE_PLAN_WEEKLY_CREDITS), UNLIMITED_PLAN]);
export const isUnlimitedLicense = (license = {}) => license.plan === UNLIMITED_PLAN;

/** Credits per seat per week for a licence: its own override, else its plan's. */
export function weeklyCreditsPerSeat(license = {}) {
  const override = license.weekly_credits_per_seat;
  if (override !== null && override !== undefined && Number.isFinite(Number(override))) return Math.max(0, Math.trunc(Number(override)));
  return LICENSE_PLAN_WEEKLY_CREDITS[license.plan] ?? LICENSE_PLAN_WEEKLY_CREDITS.premium;
}

/** The week a licence is in at `now` (counted from its creation). Pure. */
export function licenseWeek(createdAt, now = new Date()) {
  const start = new Date(createdAt).getTime();
  const at = new Date(now).getTime();
  const index = Math.max(0, Math.floor((at - start) / LICENSE_WEEK_MS));
  const startsAt = new Date(start + index * LICENSE_WEEK_MS);
  return { index, startsAt, endsAt: new Date(startsAt.getTime() + LICENSE_WEEK_MS) };
}

/** Seats that count toward the pool: devices in use, capped by the licence, at least one. */
export function seatsInUse(license, boundDevices) {
  const cap = Math.max(1, Math.trunc(Number(license?.seats) || 1));
  return Math.min(cap, Math.max(1, Math.trunc(Number(boundDevices) || 0)));
}

/** This week's row for a licence, opened (sized from devices in use) on first use; locked. */
async function lockWeek(trx, license, now) {
  const week = licenseWeek(license.created_at, now);
  const existing = await trx.selectFrom("license_credit_weeks").selectAll()
    .where("license_id", "=", license.id).where("week_index", "=", week.index).forUpdate().executeTakeFirst();
  if (existing) return existing;
  const bound = Number((await trx.selectFrom("license_devices").select((eb) => eb.fn.countAll().as("n"))
    .where("license_id", "=", license.id).where("status", "=", "active").executeTakeFirst())?.n || 0);
  const seats = seatsInUse(license, bound);
  await trx.insertInto("license_credit_weeks").values({
    license_id: license.id, week_index: week.index, starts_at: week.startsAt, ends_at: week.endsAt,
    seats_in_use: seats, credits_total: seats * weeklyCreditsPerSeat(license), credits_used: 0,
  }).onConflict((oc) => oc.columns(["license_id", "week_index"]).doNothing()).execute();
  return trx.selectFrom("license_credit_weeks").selectAll()
    .where("license_id", "=", license.id).where("week_index", "=", week.index).forUpdate().executeTakeFirstOrThrow();
}

/**
 * Charge a licence's weekly pool. `enforce` gates a new request on "anything
 * left" (the crossing request completes, as a weekly limit does); the settle
 * phase charges what really happened. Returns { ok, usageEventId?, remaining,
 * resetsAt } or { ok:false, code: "LICENSE_WEEKLY_LIMIT" | "LICENSE_UNAVAILABLE", ... }.
 */
export async function chargeLicense(db, { licenseId, userId = "", deviceId = "", credits, enforce = true, idempotencyKey = "", provider = "", model = "", feature = "chat_model", specKey = "", metadata = {}, now = new Date() }) {
  const units = Math.max(0, Math.trunc(Number(credits) || 0));
  return db.transaction().execute(async (trx) => {
    if (idempotencyKey) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`.execute(trx);
      const seen = await trx.selectFrom("usage_events").select("id").where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
      if (seen) return { ok: true, idempotent: true, usageEventId: seen.id };
    }
    const license = await trx.selectFrom("licenses").selectAll().where("id", "=", licenseId).forShare().executeTakeFirst();
    if (!license || license.status !== "active" || new Date(license.expires_at).getTime() <= now.getTime()) return { ok: false, code: "LICENSE_UNAVAILABLE" };
    const week = await lockWeek(trx, license, now);
    const used = Number(week.credits_used || 0);
    const total = Number(week.credits_total || 0);
    if (enforce && !isUnlimitedLicense(license) && used >= total) {
      return { ok: false, code: "LICENSE_WEEKLY_LIMIT", resetsAt: new Date(week.ends_at), weeklyBudget: total, weeklyUsed: used };
    }
    await trx.updateTable("license_credit_weeks").set({ credits_used: used + units })
      .where("license_id", "=", license.id).where("week_index", "=", week.week_index).execute();
    const usageEventId = publicId("usage");
    await trx.insertInto("usage_events").values({
      id: usageEventId, user_id: userId || null, device_id: deviceId || null, license_id: license.id,
      model: model || null, provider: provider || null, feature, spec_key: specKey || "default", resource_type: "token",
      billable_units: units,
      billable_tokens: Math.max(0, Math.trunc(Number(metadata?.billableTokens ?? metadata?.estimatedInputTokens ?? 0) || 0)),
      input_tokens: Math.max(0, Math.trunc(Number(metadata?.inputTokens ?? 0))) || 0,
      output_tokens: Math.max(0, Math.trunc(Number(metadata?.outputTokens ?? 0))) || 0,
      unit_cost: 1, status: "completed", idempotency_key: idempotencyKey || null,
      metadata: { ...metadata, paidBy: "license" },
    }).execute();
    return { ok: true, usageEventId, remaining: Math.max(0, total - used - units), resetsAt: new Date(week.ends_at) };
  });
}

/** This week's pool as the admin and the client see it (does not open a week). */
export async function licenseWeekStatus(db, license, now = new Date()) {
  const week = licenseWeek(license.created_at, now);
  const row = await db.selectFrom("license_credit_weeks").selectAll()
    .where("license_id", "=", license.id).where("week_index", "=", week.index).executeTakeFirst();
  const bound = Number((await db.selectFrom("license_devices").select((eb) => eb.fn.countAll().as("n"))
    .where("license_id", "=", license.id).where("status", "=", "active").executeTakeFirst())?.n || 0);
  const perSeat = weeklyCreditsPerSeat(license);
  const seats = row ? Number(row.seats_in_use) : seatsInUse(license, bound);
  const total = row ? Number(row.credits_total) : seats * perSeat;
  const used = row ? Number(row.credits_used) : 0;
  const unlimited = isUnlimitedLicense(license);
  return { plan: license.plan, unlimited, perSeat: unlimited ? null : perSeat, seatsInUse: seats, seatsCap: Number(license.seats),
    total: unlimited ? null : total, used, remaining: unlimited ? null : Math.max(0, total - used), resetsAt: week.endsAt.toISOString() };
}
