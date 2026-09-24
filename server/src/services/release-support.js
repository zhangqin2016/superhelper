/**
 * What a channel × platform still supports — the one source of "must update".
 *
 *   min_supported_version  a floor: every client below it must update
 *   blocked_versions       pulled for being bad: never offered; a client ON a
 *                          blocked version must move to a newer one — but only
 *                          if one exists (installers do not downgrade), so a
 *                          block without a fix stops the spread and forces no one
 *   mandate_deadline       after it, a mandate can no longer be postponed
 *
 * It replaces the per-release force_update flag: that hid "the fleet's floor"
 * on one release row and was once set on 20 releases by a mis-wired script flag.
 * Pure — callers load the row.
 */
import { compareVersions } from "./release-versions.js";

export const RELEASE_CHANNELS = ["stable", "beta"];
const VERSION = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/;

export function normalizeSupport(row) {
  const blocked = Array.isArray(row?.blocked_versions) ? row.blocked_versions : (() => {
    try { const parsed = JSON.parse(row?.blocked_versions || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  })();
  return {
    minSupportedVersion: String(row?.min_supported_version || ""),
    blockedVersions: [...new Set(blocked.map(String).filter(Boolean))],
    mandateDeadline: row?.mandate_deadline ? new Date(row.mandate_deadline).toISOString() : "",
  };
}

/** A reason the support policy cannot be saved, or null. */
export function supportPolicyError(input) {
  if (input.minSupportedVersion && !VERSION.test(input.minSupportedVersion)) return `minSupportedVersion must be a version like 0.1.185, got "${input.minSupportedVersion}".`;
  for (const version of input.blockedVersions || []) {
    if (!VERSION.test(String(version))) return `blocked version "${version}" is not a version.`;
  }
  if (input.minSupportedVersion && (input.blockedVersions || []).includes(input.minSupportedVersion)) {
    return `${input.minSupportedVersion} cannot be both the minimum supported version and blocked.`;
  }
  if (input.mandateDeadline && Number.isNaN(Date.parse(input.mandateDeadline))) return "mandateDeadline must be a date.";
  return null;
}

export function isBlocked(support, version) {
  return Boolean(version) && support.blockedVersions.includes(String(version));
}

/**
 * Whether a client on `currentVersion`, offered `offeredVersion`, must update.
 * @returns {{ requiredVersion: string, reason: "" | "below_minimum" | "blocked", deadline: string }}
 */
export function supportRequirement(support, { currentVersion, offeredVersion }) {
  const none = { requiredVersion: "", reason: "", deadline: "" };
  if (!currentVersion) return none;
  const deadline = support.mandateDeadline || "";
  if (support.minSupportedVersion && compareVersions(currentVersion, support.minSupportedVersion) < 0) {
    return { requiredVersion: support.minSupportedVersion, reason: "below_minimum", deadline };
  }
  if (isBlocked(support, currentVersion) && offeredVersion && compareVersions(offeredVersion, currentVersion) > 0) {
    return { requiredVersion: String(offeredVersion), reason: "blocked", deadline };
  }
  return none;
}
