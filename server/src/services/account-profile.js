export function normalizeNickname(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || [...name].length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return null;
  return name;
}

export async function updateAccountNickname(db, userId, displayName) {
  return db.transaction().execute(async trx => {
    const user = await trx.selectFrom("users").select(["id", "status", "password_must_change"])
      .where("id", "=", userId).forUpdate().executeTakeFirst();
    if (user?.status !== "active") return { ok: false, code: "USER_DISABLED" };
    if (user.password_must_change) return { ok: false, code: "PASSWORD_CHANGE_REQUIRED" };
    await trx.updateTable("users").set({ display_name: displayName }).where("id", "=", userId).execute();
    // Preserve the independent Lily ID and discoverability of existing profiles.
    await trx.updateTable("user_profiles").set({ display_name: displayName, updated_at: new Date() })
      .where("user_id", "=", userId).execute();
    return { ok: true, displayName };
  });
}
