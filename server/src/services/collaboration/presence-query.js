import { sql } from "kysely";

export async function assertPresenceAccount(database, userId, deviceId) {
  const active = await database.selectFrom("users as u").innerJoin("user_devices as d", "d.user_id", "u.id")
    .select("u.id").where("u.id", "=", userId).where("u.status", "=", "active").where("u.password_must_change", "=", false)
    .where("d.device_id", "=", deviceId).where("d.status", "=", "active").executeTakeFirst();
  if (!active) throw Object.assign(new Error("Presence account unavailable"), { status: 403, code: "COLLAB_PRESENCE_ACCOUNT_DENIED" });
}

export function createPresenceQueryRepository(db) {
  return { async authorizedDevices(userId, userIds) {
    if (!userIds.length) return new Map();
    const { rows } = await sql`
      SELECT u.id AS user_id, s.device_id, s.id AS session_id
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now()
        AND EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id=s.user_id AND d.device_id=s.device_id AND d.status='active')
      WHERE u.id IN (${sql.join(userIds)}) AND u.status='active' AND u.password_must_change=false
        AND EXISTS (SELECT 1 FROM users viewer WHERE viewer.id=${userId} AND viewer.status='active' AND viewer.password_must_change=false)
        AND (u.id=${userId} OR (
          NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_user_id=${userId} AND b.blocked_user_id=u.id) OR (b.blocker_user_id=u.id AND b.blocked_user_id=${userId}))
          AND (EXISTS (SELECT 1 FROM friendships f WHERE f.status='active' AND ((f.user_low_id=${userId} AND f.user_high_id=u.id) OR (f.user_high_id=${userId} AND f.user_low_id=u.id)))
            OR EXISTS (SELECT 1 FROM organization_members me JOIN organization_members peer ON peer.organization_id=me.organization_id JOIN organizations org ON org.id=me.organization_id
              WHERE me.user_id=${userId} AND peer.user_id=u.id AND me.status='active' AND peer.status='active' AND org.status='active'))))
    `.execute(db);
    const devices = new Map();
    for (const row of rows) {
      if (!devices.has(row.user_id)) devices.set(row.user_id, { activeDevices: new Set(), activeSessions: new Map() });
      const active = devices.get(row.user_id);
      if (row.device_id && row.session_id) { active.activeDevices.add(row.device_id); active.activeSessions.set(row.session_id, row.device_id); }
    }
    return devices;
  } };
}

export async function queryPresence({ database, repository = createPresenceQueryRepository(database), presence, userId, userIds }) {
  const ids = [...new Set(userIds)];
  const unknown = id => ({ userId: id, presence: "unknown", onlineUntil: null });
  if (!presence) return { states: ids.map(unknown), observedAt: new Date().toISOString() };
  const devices = await repository.authorizedDevices(userId, ids);
  const entries = [...devices].map(([id, active]) => ({ userId: id, ...active }));
  let values = [];
  try {
    values = presence.readBatch ? await presence.readBatch(entries) : await Promise.all(entries.map(async entry => {
      const onlineUntil = await presence.expiresAt(entry.userId, entry.activeDevices, entry.activeSessions);
      return { userId: entry.userId, presence: onlineUntil ? "online" : "offline", onlineUntil };
    }));
  } catch { /* transient state never claims offline on failure */ }
  const byId = new Map(values.map(value => [value.userId, value]));
  return { states: ids.map(id => {
    const value = devices.has(id) && byId.get(id);
    return value && ["online", "offline", "unknown"].includes(value.presence)
      ? { userId: id, presence: value.presence, onlineUntil: value.presence === "online" ? value.onlineUntil : null } : unknown(id);
  }), observedAt: new Date().toISOString() };
}
