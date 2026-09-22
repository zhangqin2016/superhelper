import { db } from "../db.js";

/**
 * Who a rule currently reaches.
 *
 * A scoped rule saved against a target that no device resolves to is invisible:
 * it lists, it looks enabled, and it never applies. The write path now refuses
 * an unknown target, but a target can also go quiet later — a license expires,
 * its devices unbind, a group empties — and a rollout percentage can hold a
 * rule back from every device it would otherwise match.
 *
 * So the admin can ask a rule what it reaches, in the identities delivery uses.
 * Read-only, bounded, and never an error: an unknown scope answers "unknown"
 * rather than pretending zero.
 */
export async function profileReach(profile, deps = {}) {
  const scope = String(profile?.scope || "");
  const targetId = String(profile?.target_id || profile?.targetId || "");
  const rolloutPercent = Number(profile?.rollout_percent ?? profile?.rolloutPercent ?? 100);
  const counts = deps.counts || defaultCounts;
  const base = { scope, targetId, rolloutPercent, enabled: profile?.enabled !== false };
  if (scope === "global") return { ...base, kind: "all", devices: await counts.allDevices(), note: "every client" };
  if (!targetId) return { ...base, kind: "unbound", devices: 0, note: "no target" };
  if (scope === "license") return { ...base, kind: "license", devices: await counts.licenseDevices(targetId) };
  if (scope === "device") return { ...base, kind: "device", devices: await counts.device(targetId) };
  if (scope === "group") return { ...base, kind: "group", devices: await counts.groupDevices(targetId) };
  if (scope === "organization") return { ...base, kind: "organization", devices: await counts.organizationMembers(targetId) };
  if (scope === "user") return { ...base, kind: "user", devices: await counts.user(targetId) };
  return { ...base, kind: "unknown", devices: null, note: "this scope is not counted by this build" };
}

const defaultCounts = {
  async allDevices() {
    const row = await db.selectFrom("devices").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    return Number(row?.n || 0);
  },
  async licenseDevices(licenseId) {
    const row = await db
      .selectFrom("license_devices")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("license_id", "=", licenseId)
      .where("status", "=", "active")
      .executeTakeFirst();
    return Number(row?.n || 0);
  },
  async device(deviceId) {
    const row = await db.selectFrom("devices").select("id").where("id", "=", deviceId).executeTakeFirst();
    return row ? 1 : 0;
  },
  async groupDevices(groupId) {
    const row = await db
      .selectFrom("devices")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("group_id", "=", groupId)
      .executeTakeFirst()
      .catch(() => null);
    return Number(row?.n || 0);
  },
  async organizationMembers(organizationId) {
    const row = await db
      .selectFrom("organization_members")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("organization_id", "=", organizationId)
      .where("status", "=", "active")
      .executeTakeFirst();
    return Number(row?.n || 0);
  },
  async user(userId) {
    const row = await db.selectFrom("users").select("id").where("id", "=", userId).executeTakeFirst();
    return row ? 1 : 0;
  },
};
