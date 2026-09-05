import { sql } from "kysely";
import { identityFacetsAvailable, withIdentityFields } from "./identity-fields.js";

export async function readEnterpriseDirectory(db, userId, presence) {
  return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    const user = await trx.selectFrom("users").select(["id", "status", "password_must_change", "display_name"])
      .where("id", "=", userId).executeTakeFirst();
    if (user?.status !== "active" || user.password_must_change) throw Object.assign(new Error("Account unavailable"), { status: 403, code: "COLLAB_ACCOUNT_UNAVAILABLE" });
    const teams = await trx.selectFrom("organization_members as viewer")
      .innerJoin("organizations as org", "org.id", "viewer.organization_id")
      .select(["org.id", "org.name", "viewer.role"])
      .where("viewer.user_id", "=", userId).where("viewer.status", "=", "active").where("org.status", "=", "active").orderBy("org.id").execute();
    const teamIds = teams.map(t => t.id);
    // Enterprise login + server-masked phone (migration 044) let a colleague
    // without a nickname still be recognised; absent the migration, neither.
    const facets = await identityFacetsAvailable(trx);
    let memberQuery = trx.selectFrom("organization_members as member")
      .innerJoin("users as u", "u.id", "member.user_id")
      .leftJoin("user_profiles as p", "p.user_id", "member.user_id")
      .select(["member.organization_id", "member.user_id", "member.role", "p.lily_id", "p.avatar_object_id",
        sql`coalesce(nullif(p.display_name, ''), u.display_name, '')`.as("display_name")]);
    if (facets) memberQuery = memberQuery.select(["u.login_name", "u.phone_e164"]);
    const members = teamIds.length ? (await memberQuery
      .where("member.organization_id", "in", teamIds).where("member.status", "=", "active").where("u.status", "=", "active")
      .orderBy("member.organization_id").orderBy("member.user_id").limit(10001).execute()).map(withIdentityFields) : [];
    if (members.length > 10000) throw Object.assign(new Error("Directory limit exceeded"), { code: "COLLAB_DIRECTORY_LIMIT" });
    const ids = [...new Set([userId, ...members.map(m => m.user_id)])];
    const sessions = presence ? await trx.selectFrom("user_sessions as session")
      .innerJoin("users as active_user", "active_user.id", "session.user_id")
      .innerJoin("user_devices as device", join => join.onRef("device.user_id", "=", "session.user_id").onRef("device.device_id", "=", "session.device_id"))
      .select(["session.user_id", "session.device_id"]).where("session.user_id", "in", ids)
      .where("active_user.status", "=", "active").where("active_user.password_must_change", "=", false)
      .where("session.revoked_at", "is", null).where("session.expires_at", ">", new Date()).where("device.status", "=", "active").distinct().execute() : [];
    const devices = new Map();
    for (const s of sessions) { if (!devices.has(s.user_id)) devices.set(s.user_id, new Set()); devices.get(s.user_id).add(s.device_id); }
    const self = await trx.selectFrom("user_profiles").select(["lily_id", "avatar_object_id"]).where("user_id", "=", userId).executeTakeFirst();
    return { profile: { userId, displayName: user.display_name || "", lilyId: self?.lily_id || "", avatarObjectId: self?.avatar_object_id || null },
      teams: teams.map(team => ({ id: team.id, scopeId: `team:${team.id}`, name: team.name, role: team.role,
        members: members.filter(m => m.organization_id === team.id).map(m => {
          const onlineUntil = presence?.expiresAt(m.user_id, devices.get(m.user_id) || new Set()) || null;
          return { userId: m.user_id, displayName: m.display_name, lilyId: m.lily_id || "", avatarObjectId: m.avatar_object_id || null,
            loginName: m.login_name || "", phoneMasked: m.phone_masked || "",
            role: m.role, presence: presence ? onlineUntil ? "online" : "offline" : "unknown", onlineUntil };
        }) })) };
  });
}
