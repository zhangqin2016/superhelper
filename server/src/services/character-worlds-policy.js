// Character Worlds rollout policy (design spec §16/§18). Conservative default:
// DISABLED. The block rides inside the existing signed client-config payload —
// there are deliberately NO character CRUD endpoints, no private content
// upload, no card analytics, and no server-side user libraries. The client
// treats an absent/invalid/stale policy as disabled and validates the profile
// against its own supported set, so a hostile or corrupt block can only ever
// turn the feature OFF, never weaken the local hard limits.

export const CHARACTER_WORLDS_DEFAULT_POLICY = Object.freeze({
  enabled: false,
  compatibilityProfile: "lily-character-compat-1",
  minimumClientVersion: "0.1.145",
});

const CHARACTER_WORLDS_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHARACTER_WORLDS_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Validate the operator env/config into the bounded deliverable policy block.
 *  Unknown/invalid fields fall back to the conservative defaults; only the
 *  three whitelisted fields are ever emitted. */
export function resolveCharacterWorldsPolicy(serverConfig = {}) {
  const profile = String(serverConfig.characterWorldsCompatibilityProfile || "");
  const minimumClientVersion = String(serverConfig.characterWorldsMinimumClientVersion || "");
  return {
    enabled: serverConfig.characterWorldsEnabled === true,
    compatibilityProfile: CHARACTER_WORLDS_PROFILE_PATTERN.test(profile)
      ? profile
      : CHARACTER_WORLDS_DEFAULT_POLICY.compatibilityProfile,
    minimumClientVersion: CHARACTER_WORLDS_VERSION_PATTERN.test(minimumClientVersion)
      ? minimumClientVersion
      : CHARACTER_WORLDS_DEFAULT_POLICY.minimumClientVersion,
  };
}

/** Numeric dotted-version compare shared by every min-client-version gate
 *  (search proxy, Character Worlds). An empty/unparseable version compares as
 *  all-zeros, i.e. fails closed against any real minimum. */
export function appVersionAtLeast(version, min) {
  const parse = (v) => String(v || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Delivery-time minimum-client-version gate (spec §18): an enabled policy is
 *  only delivered to clients new enough to honor it — older or unreported
 *  versions fail closed to disabled. The block itself always survives so the
 *  rollout state stays observable to the client. Mutates and returns the
 *  (already-copied) config for convenience. */
export function applyCharacterWorldsClientGate(configCopy, appVersion) {
  const block = configCopy?.characterWorlds;
  if (!block || typeof block !== "object" || Array.isArray(block) || block.enabled !== true) {
    return configCopy;
  }
  const minimumClientVersion = String(block.minimumClientVersion || "");
  if (minimumClientVersion && !appVersionAtLeast(appVersion, minimumClientVersion)) {
    configCopy.characterWorlds = { ...block, enabled: false };
  }
  return configCopy;
}
