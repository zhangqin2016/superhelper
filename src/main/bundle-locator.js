"use strict";

// Locates platform bundle directories and the bundled engine CLI binary.
// Depends only on config — safe for any layer (bootstrap, migrations,
// runtimes) to require without creating cycles.

const fs = require("node:fs");
const path = require("node:path");
const {
  PROJECT_ROOT,
  bundledCliBasename,
  legacyBundledCliBasenames,
} = require("./config");

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

function bundledCliSourceCandidates() {
  const names = [bundledCliBasename(), ...legacyBundledCliBasenames()];
  const paths = [];
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  for (const key of platformBundleKeys()) {
    for (const name of names) {
      if (resourcesPath) {
        paths.push(path.join(resourcesPath, "bundles", key, name));
      }
      paths.push(path.join(PROJECT_ROOT, "bundles", key, name));
    }
  }
  return paths;
}

function findBundledCliSource() {
  for (const candidate of bundledCliSourceCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = {
  platformBundleKeys,
  platformBundleKey,
  bundledCliSourceCandidates,
  findBundledCliSource,
};
