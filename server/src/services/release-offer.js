/**
 * Which release a device is offered — the one place that decides it.
 *
 * The update endpoint, the download page and the admin console all read this.
 * A release with no rollout row keeps today's meaning: enabled is offered to
 * everyone, so an empty rollout table behaves exactly as before. A release
 * with a rollout is offered by its state:
 *   complete → everyone;  rolling → the devices in its slice;
 *   draft / paused / halted → no one new.
 * The device is offered the newest release it may see.
 */
import { newestRelease } from "./release-versions.js";
import { inRollout } from "./rollout-bucket.js";
import { isBlocked, normalizeSupport, supportRequirement } from "./release-support.js";

export const DEFAULT_CHANNEL = "stable";

// A beta device sees everything stable does, plus beta's own rollouts.
export function channelsFor(channel) {
  return channel === "beta" ? ["stable", "beta"] : ["stable"];
}

function rolloutOffers(rollout, deviceId) {
  if (rollout.state === "complete") return true;
  if (rollout.state === "rolling") return inRollout(rollout.percent, rollout.id, deviceId);
  return false;
}

/**
 * A release with no rollout at all keeps today's meaning (offered to everyone).
 * A release with rollouts is offered only through one on the device's
 * channels — a beta-only release is invisible to stable. A blocked version is
 * offered to no one.
 */
export function releaseVisibleTo(release, rollouts, deviceId, { channel = DEFAULT_CHANNEL, support = null } = {}) {
  if (support && isBlocked(support, release.version)) return false;
  const list = Array.isArray(rollouts) ? rollouts : rollouts ? [rollouts] : [];
  if (!list.length) return true;
  const channels = channelsFor(channel);
  return list.some((rollout) => channels.includes(rollout.channel || DEFAULT_CHANNEL) && rolloutOffers(rollout, deviceId));
}

/**
 * @param {object} input
 * @param {object[]} input.releases   enabled releases of one platform
 * @param {object[]} input.rollouts   rollouts of that platform, any channel
 * @param {string}   [input.deviceId]
 * @param {string}   [input.currentVersion]
 * @param {string}   [input.channel]  the device's update channel
 * @param {object}   [input.support]  release_support row for the channel × platform
 */
export function offerRelease({ releases = [], rollouts = [], deviceId = "", currentVersion = "", channel = DEFAULT_CHANNEL, support = null }) {
  const policy = normalizeSupport(support);
  const byRelease = new Map();
  for (const rollout of rollouts) byRelease.set(rollout.release_id, [...(byRelease.get(rollout.release_id) || []), rollout]);
  const visible = releases.filter((release) => releaseVisibleTo(release, byRelease.get(release.id), deviceId, { channel, support: policy }));
  const release = newestRelease(visible);
  const channels = channelsFor(channel);
  const requirement = supportRequirement(policy, { currentVersion, offeredVersion: release?.version || "" });
  return {
    release,
    rollout: release ? (byRelease.get(release.id) || []).find((r) => channels.includes(r.channel || DEFAULT_CHANNEL)) || null : null,
    requiredVersion: requirement.requiredVersion,
    requiredReason: requirement.reason,
    mandateDeadline: requirement.deadline,
  };
}

/** The auto-update feed a device is pointed at for this release. */
export function releaseFeedUrl(publicBaseUrl, release) {
  const base = String(publicBaseUrl || "").replace(/\/+$/g, "");
  const platform = String(release.platform || "");
  const file = platform.startsWith("darwin-") ? "latest-mac.yml" : "latest.yml";
  if (release.immutable_feed) {
    return `${base}/app/auto-updates/${encodeURIComponent(platform)}/releases/${encodeURIComponent(release.version)}/${file}`;
  }
  return `${base}/app/auto-updates/${encodeURIComponent(platform)}/stable/${file}?v=${encodeURIComponent(release.version)}`;
}
