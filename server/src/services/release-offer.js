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
import { newestRelease, requiredVersionFor } from "./release-versions.js";
import { inRollout } from "./rollout-bucket.js";

export const DEFAULT_CHANNEL = "stable";

export function releaseVisibleTo(release, rollout, deviceId) {
  if (!rollout) return true;
  if (rollout.state === "complete") return true;
  if (rollout.state === "rolling") return inRollout(rollout.percent, rollout.id, deviceId);
  return false;
}

/**
 * @param {object} input
 * @param {object[]} input.releases   enabled releases of one platform
 * @param {object[]} input.rollouts   rollouts of that platform on the device's channel
 * @param {string}   [input.deviceId]
 * @param {string}   [input.currentVersion]
 */
export function offerRelease({ releases = [], rollouts = [], deviceId = "", currentVersion = "" }) {
  const byRelease = new Map(rollouts.map((rollout) => [rollout.release_id, rollout]));
  const visible = releases.filter((release) => releaseVisibleTo(release, byRelease.get(release.id), deviceId));
  const release = newestRelease(visible);
  return {
    release,
    rollout: release ? byRelease.get(release.id) || null : null,
    // A floor is only binding through a release the device is actually offered.
    requiredVersion: currentVersion ? requiredVersionFor(visible, currentVersion) : "",
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
