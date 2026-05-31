"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKIP_DIR_NAMES = new Set(["__MACOSX", "node_modules", ".git", ".github"]);

function isSkippedDirName(name) {
  return name.startsWith(".") || SKIP_DIR_NAMES.has(name);
}

function hasSkillMarker(dir) {
  return (
    fs.existsSync(path.join(dir, "skill.manifest.json")) ||
    fs.existsSync(path.join(dir, "SKILL.md"))
  );
}

/**
 * Locate the skill root inside an extracted archive or temp dir.
 * Handles zip layouts (single wrapper folder, __MACOSX siblings) and flat GitHub trees.
 * @param {string} extractDir
 * @returns {string | null}
 */
function findSkillRoot(extractDir) {
  if (!extractDir || !fs.existsSync(extractDir)) return null;
  if (hasSkillMarker(extractDir)) return extractDir;

  const children = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isSkippedDirName(e.name));

  if (children.length === 1) {
    const candidate = path.join(extractDir, children[0].name);
    if (hasSkillMarker(candidate)) return candidate;

    const nested = fs
      .readdirSync(candidate, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isSkippedDirName(e.name));
    if (nested.length === 1) {
      const deep = path.join(candidate, nested[0].name);
      if (hasSkillMarker(deep)) return deep;
    }
  }

  for (const child of children) {
    const candidate = path.join(extractDir, child.name);
    if (hasSkillMarker(candidate)) return candidate;
  }

  return null;
}

module.exports = {
  findSkillRoot,
  hasSkillMarker,
};
