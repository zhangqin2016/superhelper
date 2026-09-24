import { db } from "../db.js";
import { rolloutAllows } from "./client-config.js";
import { selectProfilesForTarget } from "./config-profile-selection.js";
import { DEFAULT_CHANNEL } from "./release-offer.js";
import { RELEASE_CHANNELS } from "./release-support.js";

/**
 * A device's update channel, from the same delivery rules and the same
 * selection that deliver its config (policy.updateChannel, later rule wins).
 *
 * The update check carries a device id and nothing else, so the scopes it can
 * resolve are the device's own: global, group, license, device. Rules scoped
 * to a user or an organization need a signed-in session and do not steer the
 * update channel. Unknown or unresolvable → stable, never a riskier channel.
 */
export function channelFromProfiles(applied) {
  let channel = DEFAULT_CHANNEL;
  for (const profile of applied) {
    const config = typeof profile.config === "string" ? safeParse(profile.config) : profile.config;
    const value = config?.policy?.updateChannel;
    if (typeof value === "string" && value) channel = value;
  }
  return RELEASE_CHANNELS.includes(channel) ? channel : DEFAULT_CHANNEL;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function resolveUpdateChannel(deviceId) {
  if (!deviceId) return DEFAULT_CHANNEL;
  try {
    const [device, binding, profiles] = await Promise.all([
      db.selectFrom("devices").select("group_id").where("id", "=", deviceId).executeTakeFirst(),
      db.selectFrom("license_devices").select("license_id").where("device_id", "=", deviceId).where("status", "=", "active").executeTakeFirst(),
      db.selectFrom("config_profiles").selectAll().where("enabled", "=", true).execute(),
    ]);
    if (!profiles.some((profile) => /updateChannel/.test(typeof profile.config === "string" ? profile.config : JSON.stringify(profile.config || {})))) {
      return DEFAULT_CHANNEL; // no rule names a channel: skip the lookups' meaning entirely
    }
    let groupId = device?.group_id || "";
    if (!groupId && binding?.license_id) {
      groupId = (await db.selectFrom("licenses").select("group_id").where("id", "=", binding.license_id).executeTakeFirst())?.group_id || "";
    }
    const { applied } = selectProfilesForTarget(profiles, { deviceId, licenseId: binding?.license_id || "", groupId }, { rolloutAllows });
    return channelFromProfiles(applied);
  } catch {
    return DEFAULT_CHANNEL;
  }
}
