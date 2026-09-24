import { sql } from "kysely";
import { db } from "../db.js";
import { compareVersions } from "./release-versions.js";

/**
 * How a version is doing against the one before it — shown next to a rollout.
 *
 * Rate = error diagnostics per active device over the window, per platform and
 * version. The comparison is only between versions that both report
 * diagnostics (old builds that never report would look perfect), and only
 * once a version has enough active devices to mean anything.
 */

export const HEALTH_DEFAULTS = Object.freeze({ windowHours: 24, minDevices: 20, worseRatio: 1.5 });

/** Pure: judge one version's rate against the baseline's. */
export function judgeHealth(candidate, baseline, thresholds = HEALTH_DEFAULTS) {
  if (!candidate || candidate.devices < thresholds.minDevices) return { verdict: "insufficient", reason: "too few active devices yet" };
  if (!baseline || !baseline.reporting || baseline.devices < thresholds.minDevices) return { verdict: "no_baseline", reason: "no comparable earlier version" };
  const rate = candidate.errors / candidate.devices;
  const baseRate = baseline.errors / Math.max(1, baseline.devices);
  if (baseRate === 0) return { verdict: rate > 0 ? "worse" : "ok", rate, baseRate };
  const ratio = rate / baseRate;
  return { verdict: ratio >= thresholds.worseRatio ? "worse" : "ok", rate, baseRate, ratio };
}

/**
 * Per platform-arch and version over the window: active devices, error
 * diagnostics, and whether that version reports diagnostics at all.
 */
export async function versionHealth({ windowHours = HEALTH_DEFAULTS.windowHours } = {}) {
  const since = sql`now() - ${sql.raw(`interval '${Math.max(1, Math.floor(windowHours))} hours'`)}`;
  const [devices, diagnostics] = await Promise.all([
    db.selectFrom("devices")
      .select([sql`platform || '-' || arch`.as("platform"), "app_version", sql`count(*)::int`.as("devices")])
      .where("last_seen_at", ">", since)
      .where("app_version", "is not", null)
      .groupBy([sql`platform || '-' || arch`, "app_version"])
      .execute()
      .catch(() => []),
    db.selectFrom("runtime_diagnostics")
      .select([sql`platform || '-' || arch`.as("platform"), "app_version",
        sql`count(*) filter (where severity = 'error')::int`.as("errors"),
        sql`count(*)::int`.as("reports")])
      .where("created_at", ">", since)
      .groupBy([sql`platform || '-' || arch`, "app_version"])
      .execute()
      .catch(() => []),
  ]);
  const key = (platform, version) => `${platform}@${version}`;
  const out = new Map();
  for (const row of devices) out.set(key(row.platform, row.app_version), { platform: row.platform, version: row.app_version, devices: row.devices, errors: 0, reporting: false });
  for (const row of diagnostics) {
    const entry = out.get(key(row.platform, row.app_version)) || { platform: row.platform, version: row.app_version, devices: 0, errors: 0, reporting: false };
    entry.errors = row.errors;
    entry.reporting = row.reports > 0;
    out.set(key(row.platform, row.app_version), entry);
  }
  return out;
}

/** The version a rollout is judged against: the newest older version on the platform that reports. */
export function baselineFor(health, platform, version) {
  let best = null;
  for (const entry of health.values()) {
    if (entry.platform !== platform || !entry.reporting) continue;
    if (compareVersions(entry.version, version) >= 0) continue;
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry;
  }
  return best;
}
