"use strict";

/**
 * The usage page, the way Claude and ChatGPT show it (2026-09-30): each weekly
 * allowance as a percentage used with its reset time, and the credits beyond
 * it as a plain balance. Every number is the server's — the plan's weekly
 * grant, the licence's weekly pool, the organization's weekly budget and the
 * wallet balance — so the page never estimates. The charge-by-charge record
 * lives in the website statement.
 *
 * An allowance: { kind: "plan" | "license" | "organization", tier?, unlimited,
 * percent (0–100, null when unlimited), resetsAt }.
 */

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Used / total → whole percent, clamped: the request that crosses the line completes. */
function percentUsed(used, total) {
  if (!(total > 0) || used === null) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function planAllowance(entitlements) {
  const plan = entitlements?.plan;
  if (!plan || (plan.tier !== "pro" && plan.tier !== "max")) return null;
  const total = count(plan.weeklyUnits);
  const remaining = count(plan.weekRemaining);
  if (!(total > 0) || remaining === null) return null;
  const percent = percentUsed(total - remaining, total);
  return percent === null ? null : { kind: "plan", tier: plan.tier, unlimited: false, percent, resetsAt: plan.weekResetsAt || "" };
}

function licenseAllowance(status) {
  const credits = status?.source === "server" && status.valid ? status.license?.rawPayload?.credits : null;
  if (!credits || typeof credits !== "object") return null;
  const tier = String(status.license?.plan || "");
  if (credits.unlimited) return { kind: "license", tier, unlimited: true, percent: null, resetsAt: credits.resetsAt || "" };
  const percent = percentUsed(count(credits.used), count(credits.total));
  return percent === null ? null : { kind: "license", tier, unlimited: false, percent, resetsAt: credits.resetsAt || "" };
}

function organizationAllowance(me) {
  const budget = count(me?.weeklyBudget);
  const percent = percentUsed(count(me?.weeklyUsed), budget);
  return percent === null ? null : { kind: "organization", unlimited: false, percent, resetsAt: me.weeklyResetsAt || "" };
}

/** Pure: the page from what the account, licence and organization caches hold. */
function buildUsageLimits({ signedIn = false, entitlements = null, licenseStatus = null, organizationId = "", organizationMe = null } = {}) {
  // Under the enterprise identity only the organization pays; the personal
  // plan and balance are not what this work draws on.
  const organization = Boolean(organizationId);
  const limits = [
    licenseAllowance(licenseStatus),
    signedIn && organization ? organizationAllowance(organizationMe) : null,
    signedIn && !organization ? planAllowance(entitlements) : null,
  ].filter(Boolean);
  const personal = signedIn && !organization && entitlements ? entitlements : null;
  const extra = personal ? count(personal.extraTokenBalance ?? personal.tokenBalance) : null;
  return {
    ok: true,
    signedIn: Boolean(signedIn),
    identity: organization ? "organization" : "personal",
    limits,
    extraCredits: extra,
    hasPlan: limits.some(limit => limit.kind === "plan"),
    images: personal ? count(personal.imageGenerationsRemaining) || 0 : 0,
    videos: personal ? count(personal.videoGenerationsRemaining) || 0 : 0,
  };
}

function read(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** `refresh: true` asks the server first (each source fail-open), then reads the caches. */
async function getUsageLimitsPublic(options = {}) {
  const account = () => require("./account-manager");
  if (options?.refresh) {
    const status = read(() => account().accountStatus(), null);
    await Promise.allSettled([
      status?.loggedIn ? account().refreshEntitlements() : null,
      status?.loggedIn && account().getCurrentOrganizationId() ? account().fetchOrganizations() : null,
      require("./license-manager").refreshServerLicense(),
    ]);
  }
  const status = read(() => account().accountStatus(), null);
  return buildUsageLimits({
    signedIn: Boolean(status?.loggedIn),
    entitlements: status?.entitlements || null,
    licenseStatus: read(() => require("./license-manager").getLicenseStatus(), null),
    organizationId: read(() => account().getCurrentOrganizationId(), ""),
    organizationMe: read(() => account().getCurrentOrganizationMe(), null),
  });
}

module.exports = { buildUsageLimits, getUsageLimitsPublic, percentUsed };
