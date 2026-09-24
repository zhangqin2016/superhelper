"use strict";

/**
 * Whether this device may use the installed legal knowledge pack — decided by
 * the server's last AUTHORITATIVE answer, not by whether this turn could reach
 * it.
 *
 * The pack is an entitlement: `/api/legal-kb/artifact` resolves it only for a
 * signed device on a plan that includes it, and answers 403 NOT_ENTITLED
 * otherwise. It used to be checked on every turn, and a failed check failed the
 * turn — so a network blip made the legal role unusable. Making an installed
 * pack usable without a check fixed that, and quietly let a revoked or expired
 * entitlement keep using the pack. Both are wrong. The rule:
 *
 *   - an authoritative refusal (401/403/404) disables the installed pack at
 *     once, for turns and for the search tool alike;
 *   - an authoritative grant enables it, until the entitlement's own expiry
 *     when the server states one (`entitledUntil`);
 *   - an unreachable server changes nothing: the last authoritative answer
 *     stands, bounded by that expiry, so offline use lasts exactly as long as
 *     the licence does and no longer.
 *
 * A pack installed before verdicts were recorded was installed under a grant;
 * it stays usable until the server says otherwise.
 */

const AUTHORITATIVE_STATUSES = new Set([401, 403, 404]);

function verdictFromResolve(resolved = {}, now = Date.now()) {
  if (resolved?.ok) {
    const until = Date.parse(resolved.json?.entitledUntil || resolved.entitledUntil || "");
    return { status: "granted", checkedAt: now, ...(Number.isFinite(until) ? { entitledUntil: until } : {}) };
  }
  if (AUTHORITATIVE_STATUSES.has(Number(resolved?.status))) {
    return { status: "denied", checkedAt: now, code: String(resolved.error || "NOT_ENTITLED") };
  }
  return null; // unreachable or transient: not an answer about entitlement
}

/** @returns {{ allowed: boolean, code?: string }} */
function entitlementAllows(verdict, now = Date.now()) {
  if (!verdict || typeof verdict !== "object") return { allowed: true };
  if (verdict.status === "denied") return { allowed: false, code: verdict.code || "NOT_ENTITLED" };
  if (Number.isFinite(verdict.entitledUntil) && now >= verdict.entitledUntil) {
    return { allowed: false, code: "ENTITLEMENT_EXPIRED" };
  }
  return { allowed: true };
}

module.exports = { AUTHORITATIVE_STATUSES, entitlementAllows, verdictFromResolve };
