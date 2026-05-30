"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./config");

function bundledCatalogRoots() {
  const roots = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, "resources", "skills-catalog"));
  }
  roots.push(path.join(PROJECT_ROOT, "resources", "skills-catalog"));
  return roots;
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
