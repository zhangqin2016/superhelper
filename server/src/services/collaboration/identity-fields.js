import { sql } from "kysely";
// Display facets that let a person without a nickname still be recognisable:
// the enterprise login they were issued, or their phone with the middle hidden.
// The phone is masked HERE, before a row leaves the service; clients never see
// the raw number and the local cache never stores it.
export function maskPhoneE164(phoneE164) {
  const value = String(phoneE164 || "").trim();
  if (!/^\+\d{8,15}$/.test(value)) return null;
  // Country codes are 1–3 digits and cannot be split off without a table, so
  // work from the END: the last four digits stay, the four before them are
  // hidden, and the three before those are shown — "138****5678" for a CN
  // mobile, the same shape the login response uses.
  const digits = value.slice(1);
  const head = digits.length >= 11 ? digits.slice(-11, -8) : digits.slice(0, Math.max(0, digits.length - 8));
  return `${head}****${digits.slice(-4)}`;
}

/** Add `login_name` / `phone_masked` to a row that carries `phone_e164`, and
 *  drop the raw number. Rows without the joined columns pass through untouched
 *  so callers on older schemas keep working. */
export function withIdentityFields(row) {
  if (!row || typeof row !== "object") return row;
  const { phone_e164: phone, ...rest } = row;
  const hasIdentity = "login_name" in row || phone !== undefined;
  if (!hasIdentity) return row;
  return { ...rest, login_name: row.login_name ?? null, phone_masked: maskPhoneE164(phone) };
}

/**
 * Whether the `users` table carries the facet columns (migration 044). The
 * bootstrap must keep working on a database that has not run it yet — the API
 * can be deployed ahead of the migration — so callers join only when both
 * columns exist. Detected once per process; a failed probe is not cached, so
 * a transient error just means "no facets this time".
 */
let facetProbe = null;
export function identityFacetsAvailable(executor) {
  if (facetProbe) return facetProbe;
  const probe = sql`select column_name from information_schema.columns where table_name = 'users' and column_name in ('login_name', 'phone_e164')`
    .execute(executor)
    .then((result) => {
      const names = new Set((result.rows || []).map((row) => row.column_name));
      return names.has("login_name") && names.has("phone_e164");
    })
    .catch(() => { facetProbe = null; return false; });
  facetProbe = probe;
  return probe;
}

/** Test hook: forget the probe so the next call re-checks the schema. */
export function resetIdentityFacetProbeForTests() { facetProbe = null; }
