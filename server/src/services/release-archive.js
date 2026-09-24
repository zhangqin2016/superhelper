/**
 * Which old installers may be archived, and which objects that means — pure.
 *
 * An installer stays live while anyone can be offered it or may need it: the
 * version everyone is offered, anything newer (rolling, draft), the minimum
 * supported version, and anything younger than the retention period. Only
 * what is left is a candidate, and only after an operator confirms.
 */
import { compareVersions } from "./release-versions.js";

export const ARCHIVE_SETTING = "release_archive";
export const ARCHIVE_DEFAULT = Object.freeze({ olderThanDays: 30 });

export function normalizeArchiveSettings(raw) {
  const days = Number(raw?.olderThanDays);
  return { olderThanDays: Number.isFinite(days) ? Math.min(3650, Math.max(7, Math.floor(days))) : ARCHIVE_DEFAULT.olderThanDays };
}

/**
 * @param {object} input
 * @param {object[]} input.releases      all releases (any state)
 * @param {object[]} input.rollouts      all rollouts
 * @param {Map<string,string>} input.fullByPlatform   version everyone is offered
 * @param {Map<string,string>} input.minimumByPlatform minimum supported version
 * @param {number} input.olderThanDays
 * @param {number} input.now
 */
export function archiveCandidates({ releases, rollouts = [], fullByPlatform, minimumByPlatform = new Map(), olderThanDays, now }) {
  const pending = new Set(rollouts.filter((r) => ["draft", "rolling", "paused"].includes(r.state)).map((r) => r.release_id));
  const cutoff = now - olderThanDays * 86_400_000;
  return releases.filter((release) => {
    if (release.archived_at) return false;
    const full = fullByPlatform.get(release.platform);
    if (!full) return false; // a platform with nothing offered: touch nothing
    if (compareVersions(release.version, full) >= 0) return false;
    if (pending.has(release.id)) return false;
    if (minimumByPlatform.get(release.platform) === release.version) return false;
    return new Date(release.created_at).getTime() < cutoff;
  });
}

/** The storage key behind a public URL, or "" when it is not in our bucket. */
export function keyFromUrl(publicBaseUrl, url) {
  const base = String(publicBaseUrl || "").replace(/\/+$/g, "");
  const value = String(url || "");
  if (!base || !value.startsWith(`${base}/`)) return "";
  try { return decodeURIComponent(value.slice(base.length + 1).split("?")[0]); } catch { return ""; }
}

/**
 * The objects that belong to one release: its installer, the auto-update
 * artifacts of that exact version in stable/ ("-0.1.18-" never matches
 * 0.1.183), and its own feed directory.
 */
export function objectsForRelease(release, { publicBaseUrl, stableKeys = [], feedKeys = [] }) {
  const version = String(release.version);
  const exact = new RegExp(`-${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([-.])`);
  const keys = new Set();
  const installer = keyFromUrl(publicBaseUrl, release.url);
  if (installer) keys.add(installer);
  for (const key of stableKeys) {
    const name = key.split("/").pop();
    if (/^latest(-mac)?\.yml$/.test(name)) continue; // the shared pointer is never archived
    if (exact.test(name)) keys.add(key);
  }
  for (const key of feedKeys) keys.add(key);
  return [...keys];
}
