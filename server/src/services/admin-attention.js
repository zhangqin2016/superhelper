import { sql } from "kysely";
import { db } from "../db.js";

/**
 * What the dashboard should open with: what needs a human, and the shape of
 * the fleet — not totals.
 *
 * The dashboard showed four cumulative counts. Measured against production on
 * 2026-09-23 they were worse than uninformative: "devices: 1210" was 85% dead
 * installs (1,026 not seen in 30 days; 35 seen today), while the things that
 * did need attention — failures today led by one kind, a fleet spread over
 * dozens of versions with an ancient one on top, expired licenses and licenses
 * no device uses — were on no page at all.
 *
 * Every item here is a count of something an operator can act on, and each
 * carries the page that acts on it.
 */

// Version meaning lives in one place; re-exported for existing importers.
export { compareVersions, latestReleases } from "./release-versions.js";
import { compareVersions, latestReleases } from "./release-versions.js";

async function one(builder, fallback = {}) {
  try {
    return (await builder.executeTakeFirst()) || fallback;
  } catch {
    return fallback;
  }
}

async function many(builder) {
  try {
    return await builder.execute();
  } catch {
    return [];
  }
}

export async function adminAttention() {
  const [fleet, versions, licenses, failures, failureKinds, releases, platformVersions, supportRows] = await Promise.all([
    one(db.selectFrom("devices").select([
      sql`count(*) filter (where last_seen_at > now() - interval '1 day')`.as("d1"),
      sql`count(*) filter (where last_seen_at > now() - interval '7 days')`.as("d7"),
      sql`count(*) filter (where last_seen_at > now() - interval '30 days')`.as("d30"),
      sql`count(*)`.as("installed"),
    ])),
    // Versions among devices actually in use this week: the question is "is the
    // fleet current", and dead installs would drown the answer.
    many(db.selectFrom("devices")
      .select([sql`coalesce(app_version, '(未上报)')`.as("version"), sql`count(*)`.as("devices")])
      .where(sql`last_seen_at`, ">", sql`now() - interval '7 days'`)
      .groupBy(sql`coalesce(app_version, '(未上报)')`)
      .orderBy(sql`count(*)`, "desc")
      .limit(8)),
    one(db.selectFrom("licenses").select([
      sql`count(*) filter (where status = 'active' and expires_at < now())`.as("expired_active"),
      sql`count(*) filter (where status = 'active' and expires_at between now() and now() + interval '30 days')`.as("expiring_30d"),
      sql`count(*) filter (where status = 'active' and not exists (
        select 1 from license_devices d where d.license_id = licenses.id and d.status = 'active'))`.as("unused"),
    ])),
    one(db.selectFrom("runtime_diagnostics").select([
      sql`count(*) filter (where created_at > now() - interval '1 day')`.as("d1"),
      sql`count(*) filter (where created_at > now() - interval '7 days')`.as("d7"),
    ])),
    many(db.selectFrom("runtime_diagnostics")
      .select([sql`coalesce(normalized_kind, 'unknown')`.as("kind"), sql`count(*)`.as("n")])
      .where("created_at", ">", sql`now() - interval '7 days'`)
      .groupBy(sql`coalesce(normalized_kind, 'unknown')`)
      .orderBy(sql`count(*)`, "desc")
      .limit(5)),
    many(db.selectFrom("releases")
      .select(["platform", "version"])
      .where("enabled", "=", true)),
    // The same week's fleet by platform-arch, so each device is held to the
    // forced floor of the platform it actually runs.
    many(db.selectFrom("devices")
      .select([sql`platform || '-' || arch`.as("platform"), "app_version", sql`count(*)`.as("devices")])
      .where(sql`last_seen_at`, ">", sql`now() - interval '7 days'`)
      .where("app_version", "is not", null)
      .groupBy([sql`platform || '-' || arch`, "app_version"])),
    many(db.selectFrom("release_support").select(["platform", "min_supported_version"]).where("channel", "=", "stable")),
  ]);

  const n = (value) => Number(value || 0);
  const current = latestReleases(releases);
  const activeWeek = n(fleet.d7);
  const topVersion = versions[0] || null;
  const items = [];
  if (n(failures.d1)) {
    items.push({ kind: "failures", severity: "warning", count: n(failures.d1), href: "/admin/diagnostics",
      detail: failureKinds[0] ? `${failureKinds[0].kind} ×${n(failureKinds[0].n)} (7d)` : "" });
  }
  if (n(licenses.expired_active)) items.push({ kind: "licensesExpired", severity: "danger", count: n(licenses.expired_active), href: "/admin/licenses" });
  if (n(licenses.expiring_30d)) items.push({ kind: "licensesExpiring", severity: "warning", count: n(licenses.expiring_30d), href: "/admin/licenses" });
  if (n(licenses.unused)) items.push({ kind: "licensesUnused", severity: "info", count: n(licenses.unused), href: "/admin/licenses" });
  if (activeWeek && topVersion) {
    const latest = current.map((row) => row.latest).sort(compareVersions).at(-1) || "";
    const onLatest = versions.find((row) => String(row.version) === latest);
    const behind = activeWeek - n(onLatest?.devices);
    if (latest && behind > 0) {
      items.push({ kind: "fleetBehind", severity: "warning", count: behind, href: "/admin/devices",
        detail: `${behind}/${activeWeek} · ${latest}` });
    }
  }

  // Devices in use this week below their platform's minimum supported version:
  // the ones a mandatory update is still waiting on.
  const floors = new Map(supportRows.filter((row) => row.min_supported_version).map((row) => [String(row.platform), String(row.min_supported_version)]));
  let belowRequired = 0;
  for (const row of platformVersions) {
    const floor = floors.get(String(row.platform));
    if (floor && compareVersions(row.app_version, floor) < 0) belowRequired += n(row.devices);
  }
  if (belowRequired) {
    items.push({ kind: "fleetBelowRequired", severity: "danger", count: belowRequired, href: "/admin/releases",
      detail: [...floors].map(([platform, version]) => `${platform} ≥ ${version}`).join(" · ") });
  }

  return {
    items,
    fleet: { active1d: n(fleet.d1), active7d: activeWeek, active30d: n(fleet.d30), installed: n(fleet.installed) },
    versions: versions.map((row) => ({ version: String(row.version), devices: n(row.devices), share: activeWeek ? n(row.devices) / activeWeek : 0 })),
    failures: { last1d: n(failures.d1), last7d: n(failures.d7), topKinds: failureKinds.map((row) => ({ kind: String(row.kind), count: n(row.n) })) },
    releases: current,
    required: Object.fromEntries(floors),
  };
}
