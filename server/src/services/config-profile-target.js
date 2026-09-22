import { db } from "../db.js";
import { hashLicenseKey } from "./security.js";

/**
 * What a config profile's `target_id` means, decided in ONE place.
 *
 * Field case 2026-09-22: a license-scoped rule ("按授权码下发模型") carried the
 * LICENSE KEY an operator hands to customers (LILY-…), while delivery matches
 * the license's internal id (lic_…). The rule saved, listed, and never fired —
 * every device kept the global model, and nothing anywhere said so. A scoped
 * rule that matches nothing is the worst kind of defect: it looks done.
 *
 * So the write path resolves what a human typed to the identity the matcher
 * uses, and refuses the write when it points at nothing. Delivery keeps
 * comparing ids and stays free of lookups: one representation in the table, one
 * place that establishes it.
 *
 * The lookup is injectable so the policy is testable without a database.
 */

const ID_TABLES = {
  group: { table: "config_groups", column: "id", label: "device group" },
  device: { table: "devices", column: "id", label: "device" },
  user: { table: "users", column: "id", label: "user" },
  organization: { table: "organizations", column: "id", label: "organization" },
};

export const TARGET_REQUIRED = "CONFIG_PROFILE_TARGET_REQUIRED";
export const TARGET_NOT_FOUND = "CONFIG_PROFILE_TARGET_NOT_FOUND";

async function defaultFindById(table, column, value) {
  const row = await db.selectFrom(table).select(`${column} as id`).where(column, "=", value).executeTakeFirst();
  return row?.id ? String(row.id) : null;
}

async function defaultFindLicenseByKeyHash(keyHash) {
  const row = await db
    .selectFrom("licenses")
    .select("id")
    .where("license_key_hash", "=", keyHash)
    .executeTakeFirst();
  return row?.id ? String(row.id) : null;
}

/**
 * @param {{scope: string, targetId?: string|null}} input
 * @param {{findById?: Function, findLicenseByKeyHash?: Function}} [deps]
 * @returns {Promise<{ok: true, targetId: string|null, resolvedFrom: string}
 *   | {ok: false, code: string, scope: string, targetId: string, label?: string}>}
 */
export async function resolveConfigProfileTarget(input, deps = {}) {
  const scope = String(input?.scope || "").trim();
  const raw = String(input?.targetId ?? "").trim();
  if (scope === "global") return { ok: true, targetId: null, resolvedFrom: "global" };
  if (!raw) return { ok: false, code: TARGET_REQUIRED, scope, targetId: "" };

  const findById = deps.findById || defaultFindById;
  const findLicenseByKeyHash = deps.findLicenseByKeyHash || defaultFindLicenseByKeyHash;

  if (scope === "license") {
    const byId = await findById("licenses", "id", raw);
    if (byId) return { ok: true, targetId: byId, resolvedFrom: "id" };
    // What the operator actually holds is the key. Accept it, and store the id.
    const byKey = await findLicenseByKeyHash(hashLicenseKey(raw));
    if (byKey) return { ok: true, targetId: byKey, resolvedFrom: "licenseKey" };
    return { ok: false, code: TARGET_NOT_FOUND, scope, targetId: raw, label: "license" };
  }

  const known = ID_TABLES[scope];
  // A scope this module does not know is left exactly as it was typed: a new
  // scope added elsewhere must not become unsaveable because validation here is
  // behind it.
  if (!known) return { ok: true, targetId: raw, resolvedFrom: "unvalidated" };

  const found = await findById(known.table, known.column, raw);
  if (found) return { ok: true, targetId: found, resolvedFrom: "id" };
  return { ok: false, code: TARGET_NOT_FOUND, scope, targetId: raw, label: known.label };
}

/** The 400 body for a target that points at nothing. */
export function targetErrorResponse(result) {
  const what = result.label || result.scope || "target";
  return {
    ok: false,
    code: result.code,
    message: result.code === TARGET_REQUIRED
      ? `This rule is scoped to a ${what}, so it needs a target id.`
      : `No ${what} matches "${result.targetId}". A rule that matches nothing would save and never apply, so it is refused. For a license, the license key or its internal id both work.`,
  };
}
