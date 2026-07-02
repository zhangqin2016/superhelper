import { publicId } from "./ids.js";
import { config } from "../config.js";
import { choosePricingRule, pricingUnitCost } from "./billing.js";

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

export async function fetchUserGrants(userId, trx = null) {
  trx ||= await defaultDb();
  return trx
    .selectFrom("wallet_grants")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("expires_at", "asc")
    .execute();
}

export async function fetchEntitlementSummary(userId, trx = null) {
  trx ||= await defaultDb();
  const grants = await fetchUserGrants(userId, trx);
  return summarizeEntitlements(grants);
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
} = {}) {
  const db = await defaultDb();
  const billableUnits = Math.max(1, Math.trunc(Number(units || 1))) * Math.max(0, Math.trunc(Number(unitCost ?? 1)));
  if (billableUnits <= 0) {
    return { ok: true, free: true, billableUnits: 0 };
  }
  return db.transaction().execute(async (trx) => {
    if (idempotencyKey) {
      const existing = await trx
        .selectFrom("usage_events")
        .selectAll()
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (existing) return { ok: true, idempotent: true, usageEventId: existing.id };
    }

    const grants = await fetchUserGrants(userId, trx);
    const selected = selectGrantsForConsumption(grants, {
      resourceType,
      units: billableUnits,
    });
    if (!selected.ok) return selected;

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
        unit_cost: unitCost,
        status: "completed",
        idempotency_key: idempotencyKey || null,
        metadata,
      })
      .execute();

    for (const debit of selected.debits) {
      await trx
        .updateTable("wallet_grants")
        .set((eb) => ({
          unit_remaining: eb("unit_remaining", "-", debit.units),
          ...(resourceType === "token" ? { token_remaining: eb("token_remaining", "-", debit.units) } : {}),
        }))
        .where("id", "=", debit.grant.id)
        .where("unit_remaining", ">=", debit.units)
        .executeTakeFirstOrThrow();
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

    return {
      ok: true,
      usageEventId,
      coveredByMembership: Boolean(selected.coveredByMembership),
      billableUnits,
    };
  });
}
