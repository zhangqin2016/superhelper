/**
 * A published skill version names exactly one pack.
 *
 * Clients decide whether to reinstall by version, so a different pack uploaded
 * under a version the service already holds reached nobody who had installed
 * that version — on 2026-09-25, 24 of 26 service-managed skills on one machine
 * were months stale. Changing a pack means raising its version; metadata-only
 * updates (same pack digest) stay allowed.
 */
export function publishedPackConflict(existing, sha256) {
  const published = String(existing?.sha256 || "").toLowerCase();
  const offered = String(sha256 || "").toLowerCase();
  if (!published || !offered || published === offered) return null;
  return { code: "SKILL_VERSION_IMMUTABLE", publishedSha256: published };
}
