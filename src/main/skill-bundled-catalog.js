"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");

function bundledCatalogRoots() {
  const roots = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    roots.push(path.join(process.resourcesPath, "resources", "skills-catalog"));
  }
  roots.push(path.join(PROJECT_ROOT, "resources", "skills-catalog"));
  return roots;
}

function resolveBundledCatalogDir(skillId) {
  if (!skillId) return null;
  const roots = bundledCatalogRoots();
  for (const root of roots) {
    const dir = path.join(root, skillId);
    const skillMd = path.join(dir, "SKILL.md");
    const exists = fs.existsSync(skillMd);
    if (exists) {
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
