"use strict";

const { spawnSync } = require("node:child_process");

const versionCache = new Map();

function parseCliVersion(text) {
  const match = String(text || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(version, major, minor, patch) {
  if (!version) return -1;
  for (const [left, right] of [
    [version.major, major],
    [version.minor, minor],
    [version.patch, patch],
  ]) {
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function versionAtLeast(version, major, minor, patch) {
  return compareVersion(version, major, minor, patch) >= 0;
}

function capabilitiesForVersion(version) {
  return Object.freeze({
    streamInput: true,
    emitsThinking: true,
    hotEnvUpdate: true,
    permissionControl: true,
    resume: true,
    safeMode: versionAtLeast(version, 2, 1, 169),
    fableModelAlias: versionAtLeast(version, 2, 1, 170),
    rateLimitEvent: versionAtLeast(version, 2, 1, 177),
  });
}

function detectCliVersion(cliPath) {
  const key = String(cliPath || "");
  if (!key) return { versionText: "", version: null, error: "MISSING_CLI_PATH" };
  if (versionCache.has(key)) return versionCache.get(key);

  const result = spawnSync(key, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const versionText = String(result.stdout || result.stderr || "").trim();
  const detected = {
    versionText,
    version: parseCliVersion(versionText),
    error: result.error ? result.error.message : result.status === 0 ? "" : `exit ${result.status}`,
  };
  versionCache.set(key, detected);
  return detected;
}

function detectCliCapabilities(cliPath) {
  const detected = detectCliVersion(cliPath);
  return {
    ...detected,
    capabilities: capabilitiesForVersion(detected.version),
  };
}

function clearCliCapabilityCache() {
  versionCache.clear();
}

module.exports = {
  parseCliVersion,
  compareVersion,
  versionAtLeast,
  capabilitiesForVersion,
  detectCliVersion,
  detectCliCapabilities,
  clearCliCapabilityCache,
};
