"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");

/** Candidate roots for resources/skills-catalog (electron-builder extraResources layout varies). */
function bundledCatalogRoots() {
  const roots = [];
  const relativeCandidates = [
    path.join("resources", "skills-catalog"),
    "skills-catalog",
  ];

  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    for (const rel of relativeCandidates) {
      roots.push(path.join(process.resourcesPath, rel));
    }
  }

  roots.push(path.join(PROJECT_ROOT, "resources", "skills-catalog"));

  const seen = new Set();
  const unique = [];
  for (const root of roots) {
    const normalized = path.normalize(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function resolveBundledCatalogDir(skillId) {
  if (!skillId) return null;
  for (const root of bundledCatalogRoots()) {
    const dir = path.join(root, skillId);
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return null;
}

function isBundledInCatalog(skillId) {
  return Boolean(resolveBundledCatalogDir(skillId));
}

module.exports = {
  bundledCatalogRoots,
  resolveBundledCatalogDir,
  isBundledInCatalog,
};
