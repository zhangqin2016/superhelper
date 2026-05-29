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

function isAppVersionCompatible(minAppVersion) {
  if (!minAppVersion) return true;
  return compareSemver(APP_VERSION, minAppVersion) >= 0;
}

module.exports = {
  APP_VERSION,
  compareSemver,
  isAppVersionCompatible,
};
