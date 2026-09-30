// Chat metering for the model gateway, in Lily credits: the reservation before
// the provider answers and the settlement after (licence pool, organization
// pool or personal balance). Split out of model-gateway.js (size ratchet).

import { config } from "../../config.js";
import { chatTokenUsage, gatewayAccountRequired, billableRealTokens, realTokenSplit } from "./usage.js";
import { creditRateFor, creditsForUsage, reserveCredits } from "../credit-pricing.js";
import { chargeLicense } from "../license-credits.js";
import { consumeEntitlement, fetchFeaturePricing } from "../wallet.js";
import { resolveOrgContextForRequest } from "../organization-context.js";

// Reserve (input-estimate) phase. Gates the request: rejects an empty wallet up
// front and returns a billing context so the caller can RECONCILE against the
// provider's real token usage once the response completes. Returns
// { ok:false } (reply already sent) on rejection, or { ok:true, billing } where
// billing is null for non-metered access (license / trial / anonymous).
export async function consumeChatUsage({ request, reply, token, providerId, provider, body }) {
  const account = gatewayAccountRequired({ token, enforcementEnabled: config.accountUsageEnforcementEnabled });
  if (!account.ok) {
    reply.code(402).send({ error: { type: "payment_required", message: account.code } });
    return { ok: false };
  }
  if (account.trial || account.anonymous) return { ok: true, billing: null };
  const usage = chatTokenUsage({ ...body, model: body.model || provider.model || "" });
  let pricing;
  try {
    pricing = await fetchFeaturePricing({
      feature: usage.feature,
      provider: providerId,
      model: usage.model,
      specKey: usage.specKey,
    });
  } catch (error) {
    // A licence was never blocked by our own metering; it is not now either.
    if (!account.licenseAuthorized) throw error;
    request.log?.warn?.({ err: error }, "licence pricing lookup failed; request allowed");
    return { ok: true, billing: null };
  }
  const idempotencyKey = String(request.headers["x-lily-idempotency-key"] || "").trim().slice(0, 200);
  // Charged in credits at this model's rate. The reservation prices the
  // estimated input at the cached rate (cheapest): it proves the balance can
  // pay; the answer's real usage settles the rest.
  const rate = creditRateFor(pricing.rule);
  const reserved = reserveCredits(usage.units, rate);
  const billingBase = {
    userId: token.userId, deviceId: token.deviceId || "", licenseId: token.licenseId || "", providerId,
    model: usage.model, feature: usage.feature, specKey: usage.specKey, resourceType: usage.resourceType,
    unitCost: 1, rate, estimateUnits: reserved, estimatedInputTokens: usage.units, idempotencyKey,
  };
  // A licence code opens a plan with its own weekly pool: licensed devices
  // spend it first (they were not metered at all before 2026-09-30). When it is
  // used up, the signed-in account's credits pay; a device with no account
  // waits for the reset. Our own failure never blocks a paying licence.
  if (account.licenseAuthorized) {
    let charged;
    try {
      const { db } = await import("../../db.js");
      charged = await chargeLicense(db, {
        licenseId: token.licenseId, userId: token.userId || "", deviceId: token.deviceId || "", credits: reserved, enforce: true,
        idempotencyKey, provider: providerId, model: usage.model, feature: usage.feature, specKey: usage.specKey,
        metadata: { phase: "input_estimate", estimatedInputTokens: usage.units, rate },
      });
    } catch (error) {
      request.log?.warn?.({ err: error }, "licence credit charge failed; request allowed");
      return { ok: true, billing: null };
    }
    if (charged.ok) return { ok: true, billing: { ...billingBase, mode: "license" } };
    if (!token.userId) {
      reply.code(402).send({ error: { type: "payment_required", message: charged.code,
        ...(charged.resetsAt ? { resetsAt: new Date(charged.resetsAt).toISOString(), weeklyBudget: charged.weeklyBudget, weeklyUsed: charged.weeklyUsed } : {}) } });
      return { ok: false };
    }
    // Pool used up (or the licence lapsed): the account pays, below.
  }
  const organizationId = await resolveOrgContextForRequest(request, reply, token);
  if (organizationId === null) return { ok: false };
  const consumed = await consumeEntitlement({
    userId: token.userId,
    deviceId: token.deviceId || "",
    licenseId: token.licenseId || "",
    provider: providerId,
    model: usage.model,
    feature: usage.feature,
    specKey: usage.specKey,
    resourceType: usage.resourceType,
    units: reserved,
    unitCost: 1,
    idempotencyKey,
    metadata: { phase: "input_estimate", estimatedInputTokens: usage.units, rate },
    organizationId,
  });
  if (!consumed.ok) {
    reply.code(402).send({
      error: {
        type: "payment_required",
        message: consumed.code || "ENTITLEMENT_INSUFFICIENT",
        resourceType: usage.resourceType,
        requiredUnits: consumed.requiredUnits || usage.units,
        availableUnits: consumed.availableUnits || 0,
        ...(consumed.resetsAt ? { resetsAt: new Date(consumed.resetsAt).toISOString() } : {}),
        ...(consumed.budget !== undefined && consumed.budget !== null ? { weeklyBudget: consumed.budget, weeklyUsed: consumed.used } : {}),
      },
    });
    return { ok: false };
  }
  return {
    ok: true,
    billing: {
      userId: token.userId,
      deviceId: token.deviceId || "",
      licenseId: token.licenseId || "",
      providerId,
      model: usage.model,
      feature: usage.feature,
      specKey: usage.specKey,
      resourceType: usage.resourceType,
      unitCost: 1,
      rate,
      estimateUnits: reserved,
      estimatedInputTokens: usage.units,
      idempotencyKey,
      organizationId,
    },
  };
}

// Reconcile phase: charge the DELTA between the provider's real usage
// (input + output tokens) and the already-charged input estimate. Best-effort —
// the estimate is a floor, so we never refund and never fail the turn here.
export async function reconcileChatUsage(billing, usage) {
  if (!billing || !usage?.seen) return;
  const split = realTokenSplit(usage);
  const realUnits = creditsForUsage(split, billing.rate);
  const extra = realUnits - Math.max(0, Math.trunc(Number(billing.estimateUnits || 0)));
  if (extra <= 0) return;
  if (billing.mode === "license") {
    try {
      const { db } = await import("../../db.js");
      await chargeLicense(db, {
        licenseId: billing.licenseId, userId: billing.userId || "", deviceId: billing.deviceId, credits: extra, enforce: false,
        idempotencyKey: billing.idempotencyKey ? `${billing.idempotencyKey}:final` : "", provider: billing.providerId,
        model: billing.model, feature: billing.feature, specKey: billing.specKey,
        metadata: { phase: "usage_reconcile", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: split.cachedInputTokens,
          credits: realUnits, billableTokens: Math.max(0, billableRealTokens(usage) - Math.trunc(Number(billing.estimatedInputTokens || 0))) },
      });
    } catch {
      // The answer was delivered; a failed settlement must not break it.
    }
    return;
  }
  try {
    await consumeEntitlement({
      userId: billing.userId,
      deviceId: billing.deviceId,
      licenseId: billing.licenseId,
      provider: billing.providerId,
      model: billing.model,
      feature: billing.feature,
      specKey: billing.specKey,
      resourceType: billing.resourceType,
      units: extra,
      unitCost: billing.unitCost,
      idempotencyKey: billing.idempotencyKey ? `${billing.idempotencyKey}:final` : "",
      metadata: { phase: "usage_reconcile", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cachedInputTokens: split.cachedInputTokens, freshInputTokens: split.inputTokens, credits: realUnits, realTokens: billableRealTokens(usage),
        billableTokens: Math.max(0, billableRealTokens(usage) - Math.trunc(Number(billing.estimatedInputTokens || 0))) },
      organizationId: billing.organizationId || "",
      enforceMemberLimits: false,
    });
  } catch {
    // The input estimate was already charged; a failed reconcile must not break
    // the response the user already received.
  }
}
