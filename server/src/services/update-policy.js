/**
 * How a mandatory update is carried out on a client — a delivered policy, not
 * a client constant.
 *
 * What makes an update mandatory is decided elsewhere (a forced release is a
 * floor, see release-versions.js; `policy.minAppVersion` is a per-scope floor).
 * This decides only HOW it lands: how long the restart countdown runs, how long
 * "later" postpones it, and how many times. The values are delivered with the
 * rest of the client config, so a scope (a group, a license, one device) can be
 * given a gentler or a stricter rollout without a desktop release.
 */

export const UPDATE_POLICY_DEFAULT = Object.freeze({
  countdownSeconds: 60,
  deferMinutes: 60,
  maxDeferrals: 3,
});

// Outside these a policy is refused at save: a 2-second countdown loses work,
// an unlimited deferral is no mandate at all.
export const UPDATE_POLICY_BOUNDS = Object.freeze({
  countdownSeconds: [10, 600],
  deferMinutes: [5, 1440],
  maxDeferrals: [0, 10],
});

const VERSION = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/;

/** A reason the rule's update policy cannot be saved, or null. */
export function updatePolicyError(policy) {
  if (policy === undefined || policy === null) return null;
  if (typeof policy !== "object" || Array.isArray(policy)) return { field: "policy", message: "policy must be an object." };
  const minAppVersion = policy.minAppVersion;
  if (minAppVersion !== undefined && minAppVersion !== "" && !VERSION.test(String(minAppVersion))) {
    return { field: "policy.minAppVersion", message: `policy.minAppVersion must be a version like 0.1.185, got "${minAppVersion}".` };
  }
  if (policy.updateChannel !== undefined && !["stable", "beta"].includes(policy.updateChannel)) {
    return { field: "policy.updateChannel", message: `policy.updateChannel must be stable or beta, got "${policy.updateChannel}".` };
  }
  const update = policy.update;
  if (update === undefined) return null;
  if (!update || typeof update !== "object" || Array.isArray(update)) return { field: "policy.update", message: "policy.update must be an object." };
  for (const [key, value] of Object.entries(update)) {
    const bounds = UPDATE_POLICY_BOUNDS[key];
    if (!bounds) return { field: `policy.update.${key}`, message: `policy.update.${key} is not a known setting (${Object.keys(UPDATE_POLICY_BOUNDS).join(", ")}).` };
    if (!Number.isInteger(value) || value < bounds[0] || value > bounds[1]) {
      return { field: `policy.update.${key}`, message: `policy.update.${key} must be an integer between ${bounds[0]} and ${bounds[1]}.` };
    }
  }
  return null;
}
