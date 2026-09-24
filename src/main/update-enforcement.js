"use strict";

/**
 * Whether this client MUST update, to what, and how — decided in one place.
 *
 * Two floors can make an update mandatory, and both come from the server:
 *   - the platform's support policy on the server (the update endpoint answers
 *     `requiredVersion` + `requiredReason`: below the minimum supported version,
 *     or on a blocked version with a newer one available), with an optional
 *     `mandateDeadline` after which it can no longer be postponed;
 *   - the delivered `policy.minAppVersion` of this client's scope (global,
 *     group, license, device — set on a delivery rule).
 * How a mandatory update lands — the restart countdown, how long "later"
 * postpones it, how many times — is `policy.update`, delivered the same way.
 *
 * The mandate never costs work and never locks anyone out: nothing here
 * installs, it only decides. The update manager waits for running tasks to
 * finish before any countdown starts, and when no installable release reaches
 * the floor (no such build, no auto-update feed, a failed download) the result
 * is a notice with a way to get the build, never a blocked app. A broken
 * release must not be able to strand the whole fleet.
 */

// Used only when no verified remote config is present at all (first run
// offline, expired cache). Must equal the server's UPDATE_POLICY_DEFAULT —
// scripts/test-update-enforcement.mjs holds the two together.
const FALLBACK_UPDATE_POLICY = Object.freeze({
  countdownSeconds: 60,
  deferMinutes: 60,
  maxDeferrals: 3,
});

// Same bounds the server enforces when a rule is saved; re-applied here so a
// malformed payload can neither remove the countdown nor defer forever.
const UPDATE_POLICY_BOUNDS = Object.freeze({
  countdownSeconds: [10, 600],
  deferMinutes: [5, 1440],
  maxDeferrals: [0, 10],
});

function bounded(value, key) {
  const [min, max] = UPDATE_POLICY_BOUNDS[key];
  const number = Number(value);
  if (!Number.isInteger(number)) return FALLBACK_UPDATE_POLICY[key];
  return Math.min(max, Math.max(min, number));
}

/**
 * @param {{ minAppVersion?: string, update?: object|null } | null} raw  from remote-config
 */
function normalizeUpdatePolicy(raw) {
  const update = raw?.update && typeof raw.update === "object" ? raw.update : {};
  const delivered = Boolean(raw && raw.update);
  return {
    minAppVersion: typeof raw?.minAppVersion === "string" ? raw.minAppVersion.trim() : "",
    countdownSeconds: bounded(update.countdownSeconds ?? FALLBACK_UPDATE_POLICY.countdownSeconds, "countdownSeconds"),
    deferMinutes: bounded(update.deferMinutes ?? FALLBACK_UPDATE_POLICY.deferMinutes, "deferMinutes"),
    maxDeferrals: bounded(update.maxDeferrals ?? FALLBACK_UPDATE_POLICY.maxDeferrals, "maxDeferrals"),
    source: delivered ? "delivered" : "fallback",
  };
}

const NOT_REQUIRED = Object.freeze({ required: false });

/**
 * The mandate an update answer carries: the server's floor, why, and until
 * when it may be postponed. Older servers only flagged the newest release.
 */
function requirementOf(answer = {}) {
  return {
    requiredVersion: String(answer.requiredVersion || (answer.force ? answer.version : "") || ""),
    requiredReason: String(answer.requiredReason || ""),
    mandateDeadline: String(answer.mandateDeadline || ""),
  };
}

/**
 * @param {object} input
 * @param {string} input.currentVersion
 * @param {string} input.latestVersion            newest installable release
 * @param {string} [input.releaseRequiredVersion] from the update endpoint
 * @param {ReturnType<typeof normalizeUpdatePolicy>} input.policy
 * @param {{ version?: string, count?: number, until?: number } | null} [input.deferral]  persisted
 * @param {string} [input.releaseRequiredReason]  "below_minimum" | "blocked" from the server
 * @param {string} [input.mandateDeadline]        ISO date; after it, no more postponement
 * @param {number} input.now
 * @param {(a: string, b: string) => number} input.compareVersions
 */
function decideUpdateEnforcement({ currentVersion, latestVersion, releaseRequiredVersion = "", releaseRequiredReason = "", mandateDeadline = "", policy, deferral = null, now, compareVersions }) {
  const above = (version) => Boolean(version) && compareVersions(version, currentVersion) > 0;
  const floors = [];
  if (above(releaseRequiredVersion)) floors.push({ version: String(releaseRequiredVersion), reason: releaseRequiredReason === "blocked" ? "blocked" : "release" });
  if (above(policy?.minAppVersion)) floors.push({ version: String(policy.minAppVersion), reason: "policy" });
  if (!floors.length) return NOT_REQUIRED;

  const requiredVersion = floors.reduce((top, floor) => (compareVersions(floor.version, top) > 0 ? floor.version : top), floors[0].version);
  // Deferrals belong to the version they were spent on: a newer floor is a new mandate.
  const sameMandate = deferral && deferral.version === requiredVersion;
  const used = sameMandate ? Math.max(0, Number(deferral.count) || 0) : 0;
  const until = sameMandate ? Number(deferral.until) || 0 : 0;
  // Past the deadline the mandate can no longer be postponed (it still waits for running work).
  const deadlineAt = Date.parse(mandateDeadline || "");
  const pastDeadline = Number.isFinite(deadlineAt) && now >= deadlineAt;
  const deferralsLeft = pastDeadline ? 0 : Math.max(0, policy.maxDeferrals - used);
  return {
    required: true,
    requiredVersion,
    reasons: floors.map((floor) => floor.reason),
    // Only an installable release at or past the floor can satisfy it.
    satisfiable: Boolean(latestVersion) && compareVersions(latestVersion, requiredVersion) >= 0,
    countdownSeconds: policy.countdownSeconds,
    deferMinutes: policy.deferMinutes,
    deferralsLeft,
    canDefer: deferralsLeft > 0,
    deferredUntil: !pastDeadline && until > now ? until : null,
    deadline: Number.isFinite(deadlineAt) ? new Date(deadlineAt).toISOString() : "",
    pastDeadline,
    policySource: policy.source,
  };
}

/** The deferral to persist when the user chooses "later" on this mandate. */
function nextDeferral(enforcement, deferral, now) {
  if (!enforcement?.required || !enforcement.canDefer) return null;
  const sameMandate = deferral && deferral.version === enforcement.requiredVersion;
  return {
    version: enforcement.requiredVersion,
    count: (sameMandate ? Math.max(0, Number(deferral.count) || 0) : 0) + 1,
    until: now + enforcement.deferMinutes * 60_000,
  };
}

module.exports = {
  FALLBACK_UPDATE_POLICY,
  UPDATE_POLICY_BOUNDS,
  normalizeUpdatePolicy,
  requirementOf,
  decideUpdateEnforcement,
  nextDeferral,
};
