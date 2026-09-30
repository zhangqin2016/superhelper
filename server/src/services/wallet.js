import { sql } from "kysely";
import { publicId } from "./ids.js";
import { ensurePlanAllowances, activePlanOf, byokAllowedFor } from "./wallet-plans.js";
import { config } from "../config.js";
import { choosePricingRule, pricingUnitCost } from "./billing.js";
import {
  effectiveWeeklyBudget,
  orgConsumptionDecision,
  orgUnavailableCode,
  weeklyBudgetDecision,
  weeklyWindowAfterCharge,
} from "./enterprise.js";

async function defaultDb() {
  const mod = await import("../db.js");
  return mod.db;
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function grant({
  userId,
  sourceType,
  grantType,
  resourceType,
  unitTotal,
  startsAt,
  expiresAt,
}) {
  return {
    id: publicId("grant"),
    user_id: userId,
    source_type: sourceType,
    source_id: userId,
    grant_type: grantType,
    resource_type: resourceType,
    token_total: resourceType === "token" ? unitTotal : 0,
    token_remaining: resourceType === "token" ? unitTotal : 0,
    unit_total: unitTotal,
    unit_remaining: unitTotal,
    starts_at: startsAt,
    expires_at: expiresAt,
    status: "active",
    metadata: {},
  };
}

export function createSignupGrants({
  userId,
  now = new Date(),
  freeTokens = 100000,
  freeImages = 3,
  freeVideos = 1,
  freeDays = 7,
} = {}) {
  const startsAt = now.toISOString();
  const expiresAt = addDays(now, freeDays).toISOString();
  return [
    grant({
      userId,
      sourceType: "free_signup",
      grantType: "free_tokens",
      resourceType: "token",
      unitTotal: Number(freeTokens || 0),
      startsAt,
      expiresAt,
    }),
    grant({
      userId,
      sourceType: "free_signup",
      grantType: "free_image_generations",
      resourceType: "image_generation",
      unitTotal: Number(freeImages || 0),
      startsAt,
      expiresAt,
    }),
    grant({
      userId,
      sourceType: "free_signup",
      grantType: "free_video_generations",
      resourceType: "video_generation",
      unitTotal: Number(freeVideos || 0),
      startsAt,
      expiresAt,
    }),
  ].filter((item) => item.unit_total > 0);
}

export function summarizeEntitlements(grants = [], { now = new Date() } = {}) {
  const nowMs = now.getTime();
  let tokenBalance = 0;
  let imageGenerationsRemaining = 0;
  let videoGenerationsRemaining = 0;
  let membershipExpiresAt = "";
  let freeGrantExpiresAt = "";

  for (const grant of grants || []) {
    if (!grant || grant.status !== "active") continue;
    const startsAt = new Date(grant.starts_at || 0).getTime();
    const expiresAt = new Date(grant.expires_at || 0).getTime();
    if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt)) continue;
    if (startsAt > nowMs || expiresAt <= nowMs) continue;
    const remaining = Number(grant.unit_remaining ?? grant.token_remaining ?? 0);
    if (grant.resource_type === "token") tokenBalance += remaining;
    if (grant.resource_type === "image_generation") imageGenerationsRemaining += remaining;
    if (grant.resource_type === "video_generation") videoGenerationsRemaining += remaining;
    if (grant.resource_type === "membership" && (!membershipExpiresAt || expiresAt > Date.parse(membershipExpiresAt))) {
      membershipExpiresAt = new Date(expiresAt).toISOString();
    }
    if (String(grant.grant_type || "").startsWith("free_") && (!freeGrantExpiresAt || expiresAt > Date.parse(freeGrantExpiresAt))) {
      freeGrantExpiresAt = new Date(expiresAt).toISOString();
    }
  }

  return {
    usable: Boolean(tokenBalance > 0 || imageGenerationsRemaining > 0 || videoGenerationsRemaining > 0 || membershipExpiresAt),
    tokenBalance,
    imageGenerationsRemaining,
    videoGenerationsRemaining,
    membershipExpiresAt,
    freeGrantExpiresAt,
  };
}

export function selectGrantsForConsumption(grants = [], { resourceType, units = 1, now = new Date() } = {}) {
  const requested = Math.max(1, Math.trunc(Number(units || 1)));
  const nowMs = now.getTime();
  const active = (grants || [])
    .filter((grant) => {
      if (!grant || grant.status !== "active") return false;
      const startsAt = new Date(grant.starts_at || 0).getTime();
      const expiresAt = new Date(grant.expires_at || 0).getTime();
      if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt)) return false;
      return startsAt <= nowMs && expiresAt > nowMs;
    })
    .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime());

  const membership = active.find((grant) => grant.resource_type === "membership");
  if (membership) {
    return { ok: true, coveredByMembership: true, debits: [], units: requested };
  }

  let remaining = requested;
  const debits = [];
  for (const grant of active) {
    if (grant.resource_type !== resourceType) continue;
    const available = Number(grant.unit_remaining ?? grant.token_remaining ?? 0);
    if (available <= 0) continue;
    const unitsToDebit = Math.min(available, remaining);
    debits.push({ grant, units: unitsToDebit });
    remaining -= unitsToDebit;
    if (remaining <= 0) break;
  }

  if (remaining > 0) {
    return {
      ok: false,
      code: "ENTITLEMENT_INSUFFICIENT",
      resourceType,
      requiredUnits: requested,
      availableUnits: requested - remaining,
    };
  }
  return { ok: true, coveredByMembership: false, debits, units: requested };
}

export async function ensureSignupGrants(userId, trx = null) {
  trx ||= await defaultDb();
  const existing = await trx
    .selectFrom("wallet_grants")
    .select("id")
    .where("user_id", "=", userId)
    .where("source_type", "=", "free_signup")
    .executeTakeFirst();
  if (existing) return [];

  const grants = createSignupGrants({
    userId,
    freeTokens: config.accountFreeTokens,
    freeImages: config.accountFreeImages,
    freeVideos: config.accountFreeVideos,
    freeDays: config.accountFreeDays,
  });
  if (!grants.length) return [];
  await trx.insertInto("wallet_grants").values(grants).execute();
  await trx
    .insertInto("wallet_ledger")
    .values(grants.map((item) => ({
      id: publicId("ledger"),
      user_id: userId,
      grant_id: item.id,
      event_type: "grant",
      resource_type: item.resource_type,
      token_delta: item.resource_type === "token" ? item.unit_total : 0,
      unit_delta: item.unit_total,
      source_type: item.source_type,
      source_id: item.source_id,
      idempotency_key: `free_signup:${userId}:${item.resource_type}`,
      metadata: {},
    })))
    .execute();
  return grants;
}

export async function fetchUserGrants(userId, trx = null, { forUpdate = false } = {}) {
  trx ||= await defaultDb();
  let query = trx
    .selectFrom("wallet_grants")
    .selectAll()
    .where("user_id", "=", userId)
    // Only personal grants feed the personal consumption path. Org-pool
    // grants (organization_id NOT NULL) are consumed only via the org path
    // (consumeEntitlement with an explicit organizationId), so they can never
    // be mistaken for personal balance.
    .where("organization_id", "is", null)
    .orderBy("expires_at", "asc")
    .orderBy("id", "asc");
  if (forUpdate) query = query.forUpdate();
  return query.execute();
}

/**
 * Fetch org-pool grants for an organization. Includes only active rows that
 * are currently within their validity window (runtime filtering, same as the
 * personal path); membership + org status are checked by the caller
 * (consumeEntitlement / resolveOrgForConsumption).
 */
export async function fetchOrgGrants(organizationId, trx = null, { forUpdate = false } = {}) {
  trx ||= await defaultDb();
  let query = trx
    .selectFrom("wallet_grants")
    .selectAll()
    .where("organization_id", "=", organizationId)
    .orderBy("expires_at", "asc")
    .orderBy("id", "asc");
  if (forUpdate) query = query.forUpdate();
  return query.execute();
}

/**
 * Is this user, right now, a usable member of this organization? Reads the org
 * and the membership (locked when `forUpdate`, as the charge path does) and
 * says why not: ORG_NOT_FOUND, ORG_SUSPENDED (platform freeze), ORG_DISABLED
 * (the enterprise's own pause), ORG_MEMBER_REQUIRED, ORG_MEMBER_DISABLED.
 */
export async function loadOrgAccess(trx, { userId, organizationId, forUpdate = false }) {
  if (!organizationId) return { ok: false, code: "ORG_NOT_FOUND" };
  let orgQuery = trx
    .selectFrom("organizations")
    .select(["id", "status", "owner_status", "platform_status", "default_member_weekly_budget"])
    .where("id", "=", organizationId);
  if (forUpdate) orgQuery = orgQuery.forShare();
  const org = await orgQuery.executeTakeFirst();
  if (!org) return { ok: false, code: "ORG_NOT_FOUND" };
  const unavailable = orgUnavailableCode(org);
  if (unavailable) return { ok: false, code: unavailable };
  let memberQuery = trx
    .selectFrom("organization_members")
    .select(["user_id", "status", "quota", "weekly_budget", "weekly_window_started_at", "weekly_used"])
    .where("organization_id", "=", organizationId)
    .where("user_id", "=", userId);
  if (forUpdate) memberQuery = memberQuery.forUpdate();
  const member = await memberQuery.executeTakeFirst();
  if (!member) return { ok: false, code: "ORG_MEMBER_REQUIRED" };
  if (member.status !== "active") return { ok: false, code: "ORG_MEMBER_DISABLED" };
  return { ok: true, org, member, weeklyBudget: effectiveWeeklyBudget(member.weekly_budget, org.default_member_weekly_budget) };
}

/**
 * May this user act under this organization's identity at all? The gateway asks
 * before metering (identity check only — the per-request cap, weekly budget and
 * pool are judged by the charge itself, under lock).
 */
export async function resolveOrgForConsumption({ userId, organizationId }, trx = null) {
  trx ||= await defaultDb();
  const access = await loadOrgAccess(trx, { userId, organizationId });
  if (!access.ok) return access;
  return { ok: true, cap: access.member.quota ?? null };
}

/** The member's weekly budget as they would see it now (for the console and the client). */
export async function memberWeeklyStatus({ userId, organizationId }, trx = null) {
  trx ||= await defaultDb();
  const access = await loadOrgAccess(trx, { userId, organizationId });
  if (!access.ok) return access;
  const decision = weeklyBudgetDecision({
    budget: access.weeklyBudget,
    windowStartedAt: access.member.weekly_window_started_at,
    used: Number(access.member.weekly_used || 0),
  });
  return { ok: true, weeklyBudget: decision.budget, weeklyUsed: decision.used, resetsAt: decision.resetsAt, limited: !decision.ok, perRequestCap: access.member.quota ?? null };
}

// Plans (Pro/Max weekly allowance, BYOK verdict) live in wallet-plans.js.
export { PLAN_WEEK_MS, planWeek, ensurePlanAllowances, activePlanOf, byokAllowedFor } from "./wallet-plans.js";

export async function fetchEntitlementSummary(userId, trx = null) {
  const database = trx || await defaultDb();
  // Hand out this week's plan allowance first, so the balance a client reads
  // already includes it. Its own transaction: the advisory lock is per-key.
  const run = (fn) => trx ? fn(trx) : database.transaction().execute(fn);
  const allGrants = await run(async (t) => {
    await ensurePlanAllowances(t, userId);
    return t.selectFrom("wallet_grants").selectAll().where("user_id", "=", userId).where("organization_id", "is", null).execute();
  });
  const personal = allGrants.filter((grant) => grant.resource_type !== "plan");
  const summary = summarizeEntitlements(personal);
  const plan = activePlanOf(allGrants);
  const nowMs = Date.now();
  const week = allGrants.filter((grant) => grant.grant_type === "plan_weekly" && grant.status === "active"
    && new Date(grant.starts_at).getTime() <= nowMs && new Date(grant.expires_at).getTime() > nowMs)
    .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))[0];
  const byok = await byokAllowedFor(userId, allGrants, database);
  return {
    ...summary,
    // Credits beyond this week's plan allowance (top-ups, gifts): what the
    // usage page shows next to the plan's percentage.
    extraTokenBalance: summarizeEntitlements(personal.filter((grant) => grant.grant_type !== "plan_weekly")).tokenBalance,
    plan: plan ? { ...plan, ...(week ? { weekRemaining: Number(week.unit_remaining || 0), weekResetsAt: new Date(week.expires_at).toISOString() } : {}) } : null,
    byokAllowed: byok.allowed,
    byokReason: byok.reason,
  };
}

export async function fetchFeaturePricing({
  feature,
  provider = "",
  model = "",
  specKey = "default",
} = {}, trx = null) {
  trx ||= await defaultDb();
  const rows = await trx
    .selectFrom("feature_pricing_rules")
    .selectAll()
    .where("feature", "=", feature)
    .where("enabled", "=", true)
    .execute();
  const rule = choosePricingRule(rows, { feature, provider, model, specKey });
  return {
    rule,
    unitCost: pricingUnitCost(rule),
  };
}

export async function consumeEntitlement({
  userId,
  deviceId = "",
  licenseId = "",
  provider = "",
  model = "",
  feature,
  specKey = "",
  resourceType,
  units = 1,
  unitCost = 1,
  idempotencyKey = "",
  metadata = {},
  organizationId = "",
  // false only for the reconcile phase: the work already happened, so the
  // per-request cap and the weekly gate do not apply to charging for it.
  enforceMemberLimits = true,
} = {}) {
  const db = await defaultDb();
  const billableUnits = Math.max(1, Math.trunc(Number(units || 1))) * Math.max(0, Math.trunc(Number(unitCost ?? 1)));
  if (billableUnits <= 0) {
    return { ok: true, free: true, billableUnits: 0 };
  }
  return db.transaction().execute(async (trx) => {
    if (idempotencyKey) {
      // Serialize retries before looking up their receipt; otherwise concurrent
      // retries race the unique usage-event key after spending the same grant.
      await sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`.execute(trx);
      const existing = await trx
        .selectFrom("usage_events")
        .selectAll()
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (existing && existing.user_id !== userId) return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
      if (existing) return { ok: true, idempotent: true, usageEventId: existing.id };
    }

    // The identity the user chose decides whose quota pays — never both. Under
    // an organization identity only the org pool is charged, with the member's
    // per-request cap and weekly budget; under the personal identity only the
    // personal balance. (It used to charge personal first and fall back to the
    // pool, so a platform grant showed zero consumption and a pool shortage was
    // reported as the personal ENTITLEMENT_INSUFFICIENT.)
    let selected;
    let orgMember = null;
    if (organizationId) {
      const access = await loadOrgAccess(trx, { userId, organizationId, forUpdate: true });
      if (!access.ok) return access;
      if (enforceMemberLimits) {
        const cap = orgConsumptionDecision({ memberStatus: access.member.status, orgStatus: access.org.status, quota: access.member.quota, requestedUnits: billableUnits });
        if (!cap.ok) return cap;
        const weekly = weeklyBudgetDecision({ budget: access.weeklyBudget, windowStartedAt: access.member.weekly_window_started_at, used: Number(access.member.weekly_used || 0) });
        if (!weekly.ok) return weekly;
      }
      const orgGrants = await fetchOrgGrants(organizationId, trx, { forUpdate: true });
      selected = selectGrantsForConsumption(orgGrants, { resourceType, units: billableUnits });
      if (!selected.ok) return { ...selected, code: "ORG_POOL_INSUFFICIENT" };
      orgMember = access.member;
    } else {
      await ensurePlanAllowances(trx, userId);
      const grants = await fetchUserGrants(userId, trx, { forUpdate: true });
      selected = selectGrantsForConsumption(grants, { resourceType, units: billableUnits });
      if (!selected.ok) return selected;
    }
    const usedOrganization = Boolean(orgMember);

    const usageEventId = publicId("usage");
    await trx
      .insertInto("usage_events")
      .values({
        id: usageEventId,
        user_id: userId,
        device_id: deviceId || null,
        license_id: licenseId || null,
        model: model || null,
        provider: provider || null,
        feature,
        spec_key: specKey || "default",
        resource_type: resourceType,
        billable_units: billableUnits,
        // The token columns existed and were never written: 18,828 production
        // events carried model, feature and cost but no token counts, so
        // "how are tokens actually distributed" had no answer at this grain.
        // Everything here is already known to this call — units ARE tokens when
        // the resource is tokens, and the reconcile phase passes the real split
        // in metadata. Nothing is inferred.
        // Units are credits now; the raw token count is what the call says it
        // was (estimate, or the reconcile's share of the real total).
        billable_tokens: resourceType === "token"
          ? Math.max(0, Math.trunc(Number(metadata?.billableTokens ?? metadata?.estimatedInputTokens ?? billableUnits) || 0)) : 0,
        input_tokens: Math.max(0, Math.trunc(Number(metadata?.inputTokens ?? 0))) || 0,
        output_tokens: Math.max(0, Math.trunc(Number(metadata?.outputTokens ?? 0))) || 0,
        unit_cost: unitCost,
        status: "completed",
        idempotency_key: idempotencyKey || null,
        metadata,
        organization_id: usedOrganization ? organizationId : null,
      })
      .execute();

    for (const debit of selected.debits) {
      const updated = await trx
        .updateTable("wallet_grants")
        .set((eb) => ({
          unit_remaining: eb("unit_remaining", "-", debit.units),
          ...(resourceType === "token" ? { token_remaining: eb("token_remaining", "-", debit.units) } : {}),
        }))
        .where("id", "=", debit.grant.id)
        .where("unit_remaining", ">=", debit.units)
        .executeTakeFirstOrThrow();
      if (Number(updated.numUpdatedRows) !== 1) throw Object.assign(new Error("ENTITLEMENT_DEBIT_CONFLICT"), { code: "ENTITLEMENT_DEBIT_CONFLICT" });
      await trx
        .insertInto("wallet_ledger")
        .values({
          id: publicId("ledger"),
          user_id: userId,
          grant_id: debit.grant.id,
          event_type: "consume",
          resource_type: resourceType,
          token_delta: resourceType === "token" ? -debit.units : 0,
          unit_delta: -debit.units,
          source_type: "usage",
          source_id: usageEventId,
          idempotency_key: idempotencyKey ? `${idempotencyKey}:${debit.grant.id}` : null,
          metadata,
        })
        .execute();
    }

    if (orgMember) {
      await trx
        .updateTable("organization_members")
        .set(weeklyWindowAfterCharge({ windowStartedAt: orgMember.weekly_window_started_at, used: Number(orgMember.weekly_used || 0), units: billableUnits }))
        .where("organization_id", "=", organizationId)
        .where("user_id", "=", userId)
        .execute();
    }

    return {
      ok: true,
      usageEventId,
      coveredByMembership: Boolean(selected.coveredByMembership),
      billableUnits,
    };
  });
}
