import { createHash } from "node:crypto";

/**
 * Which slice of the fleet a staged rollout reaches, decided once.
 *
 * Delivery rules (rollout_percent) and release rollouts use the same bucket:
 * sha256("<key>:<deviceId>") → 0..99. Keyed by the rule or rollout id, so each
 * rollout reaches a different slice — not always the same unlucky devices.
 */
export function rolloutBucket(key, deviceId) {
  const hash = createHash("sha256").update(`${key}:${deviceId}`).digest("hex").slice(0, 8);
  return Number.parseInt(hash, 16) % 100;
}

/** Whether a device falls inside `percent` of the rollout keyed by `key`. */
export function inRollout(percent, key, deviceId) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return true;
  if (value <= 0) return false;
  if (value >= 100) return true;
  if (!deviceId) return false; // an anonymous request only sees what everyone sees
  return rolloutBucket(key, deviceId) < value;
}
