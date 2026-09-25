"use strict";

const { version: APP_VERSION } = require("../../package.json");

function parseParts(version) {
  return String(version || "0.0.0")
    .split(".")
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** @returns {-1 | 0 | 1} */
function compareSemver(a, b) {
  const pa = parseParts(a);
  const pb = parseParts(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Whether the registry offers a skill pack this machine does not have.
 *
 * A higher version, as before — or the SAME version whose pack is a different
 * file. A version used to be republished in place (the publisher uploaded a
 * changed pack under the version it already had), and a version comparison
 * alone can never see that: on 2026-09-25, 24 of 26 service-managed skills on
 * the developer's machine had been republished since install and still ran
 * their June/July guides. The pack digest is what was actually installed
 * (skill-installer records it), so a differing digest is new content. A pack
 * without a recorded digest (bundled, GitHub-sourced) is judged by version
 * alone, exactly as before.
 *
 * @returns {{ available: boolean, reason: "version" | "content" | null }}
 */
function registryUpdate(registryEntry, installedVersion, installedSha256) {
  const latest = registryEntry?.latestVersion;
  if (!latest || !installedVersion) return { available: false, reason: null };
  const order = compareSemver(latest, installedVersion);
  if (order > 0) return { available: true, reason: "version" };
  if (order < 0 || registryEntry.sourceType === "github") return { available: false, reason: null };
  const offered = String(registryEntry.sha256 || "");
  const have = String(installedSha256 || "");
  if (!SHA256_RE.test(offered) || !SHA256_RE.test(have)) return { available: false, reason: null };
  return offered.toLowerCase() === have.toLowerCase()
    ? { available: false, reason: null }
    : { available: true, reason: "content" };
}

function isAppVersionCompatible(minAppVersion) {
  if (!minAppVersion) return true;
  return compareSemver(APP_VERSION, minAppVersion) >= 0;
}

module.exports = {
  APP_VERSION,
  compareSemver,
  isAppVersionCompatible,
  registryUpdate,
};
