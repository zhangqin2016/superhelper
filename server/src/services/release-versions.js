/**
 * What a release list means, decided once: version order, the newest release,
 * and the version a client MUST reach.
 *
 * Two copies of version order lived apart (the public update endpoint and the
 * admin dashboard). And "must update" was read off the newest release alone —
 * so a forced 0.1.185 followed by an ordinary 0.1.186 told every client below
 * 0.1.185 that nothing was mandatory. A forced release is a floor: every client
 * below it must update, whatever was published after it.
 */

/** Semantic version order — text order says "0.1.99" is newer than "0.1.183". */
export function compareVersions(a, b) {
  const parts = (value) => String(value || "").split(/[.+-]/).map((piece) => (/^\d+$/.test(piece) ? Number(piece) : piece));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    // A text part is a pre-release tag: 0.1.0-beta comes before 0.1.0.
    if (left[i] === undefined && typeof right[i] === "string") return 1;
    if (right[i] === undefined && typeof left[i] === "string") return -1;
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/** Newest by version; a republished version (same number) resolves to the later row. */
export function newestRelease(releases) {
  return (releases || []).reduce((best, release) => {
    if (!best) return release;
    const order = compareVersions(release.version, best.version);
    if (order > 0) return release;
    if (order === 0 && new Date(release.created_at).getTime() > new Date(best.created_at).getTime()) return release;
    return best;
  }, null);
}

/** Latest enabled release per platform. */
export function latestReleases(rows = []) {
  const byPlatform = new Map();
  for (const row of rows) {
    const platform = String(row.platform || "");
    const entry = byPlatform.get(platform) || { platform, latest: "", records: 0 };
    entry.records += 1;
    if (!entry.latest || compareVersions(row.version, entry.latest) > 0) entry.latest = String(row.version || "");
    byPlatform.set(platform, entry);
  }
  return [...byPlatform.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}

/**
 * The version a client on `currentVersion` must reach: the highest forced
 * release above it, or "" when nothing is mandatory. Rows are one platform's
 * enabled releases. A client already at or past every forced release owes
 * nothing, however many forced releases exist below it.
 */
export function requiredVersionFor(releases, currentVersion) {
  let required = "";
  for (const release of releases || []) {
    if (!release?.force_update) continue;
    if (compareVersions(release.version, currentVersion) <= 0) continue;
    if (!required || compareVersions(release.version, required) > 0) required = String(release.version);
  }
  return required;
}

/** Per platform: the highest forced release — the floor the whole fleet owes. */
export function forcedFloors(rows = []) {
  const floors = new Map();
  for (const row of rows) {
    if (!row?.force_update) continue;
    const platform = String(row.platform || "");
    const current = floors.get(platform);
    if (!current || compareVersions(row.version, current) > 0) floors.set(platform, String(row.version));
  }
  return floors;
}
