"use strict";

/**
 * Bring-your-own-key (自配置模型) plan gate — the ONE decision.
 *
 * The server's account entitlement summary carries `byokAllowed` /
 * `byokReason` / `plan`. Whether BYOK needs a plan is an operator switch on the
 * server; the client only obeys an explicit answer. Every other state — field
 * missing (older server), signed out, a valid licence, no entitlements cached
 * because a fetch failed — keeps today's behaviour: allowed. A network error
 * can never produce a block (it never produces `byokAllowed === false`).
 *
 * Pure: inputs in, verdict out. Main-process enforcement (model-presets,
 * model-selection-catalog) and the renderer view model (the `byok` object those
 * IPC payloads carry) all read this verdict; nothing else interprets
 * `byokAllowed`.
 */

const PRICING_URL = "https://lilywb.cn/pricing";
const REASONS = new Set(["open", "plan", "organization", "plan_required"]);

function decideByok({ loggedIn = false, entitlements = null, licenseValid = false } = {}) {
  const e = entitlements && typeof entitlements === "object" ? entitlements : null;
  const serverReason = REASONS.has(e?.byokReason) ? e.byokReason : "";
  const blocked = Boolean(loggedIn) && Boolean(e) && e.byokAllowed === false && !licenseValid;
  if (!blocked) {
    return { allowed: true, reason: serverReason && serverReason !== "plan_required" ? serverReason : "open", pricingUrl: PRICING_URL };
  }
  return { allowed: false, reason: "plan_required", pricingUrl: PRICING_URL };
}

/** A custom (BYOK) preset/model is locked exactly when the verdict says blocked. */
function isByokLocked(entry, decision) {
  return Boolean(entry?.custom) && decision?.allowed === false;
}

module.exports = { decideByok, isByokLocked, PRICING_URL };
