"use strict";

// Locates platform bundle directories and the bundled OpenCode engine binary.
// Depends only on config — safe for any layer (migrations, runtimes) to require
// without creating cycles.

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");

/** Platform keys to search for bundled binaries (order matters). */
function platformBundleKeys() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return ["darwin-arm64", "darwin-x64"];
    return ["darwin-x64", "darwin-arm64"];
  }
  if (process.platform === "win32") return ["win32-x64"];
  return ["linux-x64"];
}

function platformBundleKey() {
  return platformBundleKeys()[0];
}

/** Locate a bundled OpenCode engine binary at bundles/<key>/opencode/bin/opencode
 *  (prebuilt opencode-ai layout), or null if not bundled. */
function findBundledOpencodeBinary() {
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  const rels = [path.join("opencode", "bin", exe), path.join("opencode", exe)];
  for (const key of platformBundleKeys()) {
    for (const rel of rels) {
      if (resourcesPath) {
        const inRes = path.join(resourcesPath, "bundles", key, rel);
        if (fs.existsSync(inRes)) return inRes;
      }
      const inRepo = path.join(PROJECT_ROOT, "bundles", key, rel);
      if (fs.existsSync(inRepo)) return inRepo;
    }
  }
  return null;
}

/** First existing `bundles/<key>/runtime` directory (resources or repo), or "". */
function bundleRuntimeDir() {
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  for (const key of platformBundleKeys()) {
    const candidates = [];
    if (resourcesPath) candidates.push(path.join(resourcesPath, "bundles", key, "runtime"));
    candidates.push(path.join(PROJECT_ROOT, "bundles", key, "runtime"));
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
  }
  return "";
}

module.exports = {
  platformBundleKeys,
  platformBundleKey,
  findBundledOpencodeBinary,
  bundleRuntimeDir,
};
