"use strict";

function hasLegacyMirrorConflict({
  files,
  workspaceSkillFiles,
  hasConventions,
  manifestName,
  conventionsEntry,
  filesPrefix,
  skillsPrefix,
}) {
  const rootEntries = new Set(files.map((file) => file.relPath));
  if (rootEntries.has(manifestName)) return true;
  if (hasConventions && rootEntries.has(conventionsEntry)) return true;
  for (const file of files) {
    if (rootEntries.has(`${filesPrefix}${file.relPath}`)) return true;
  }
  for (const file of workspaceSkillFiles) {
    if (rootEntries.has(`${skillsPrefix}${file.skillId}/${file.relPath}`)) return true;
  }
  return false;
}

function isLegacyFileMirrorEntry(entryName, zip, filesPrefix) {
  if (!entryName.startsWith(filesPrefix)) return false;
  const rootName = entryName.slice(filesPrefix.length);
  return Boolean(rootName && zip.file(rootName));
}

function isLegacySkillMirrorEntry(entryName, zip, skillsPrefix, hiddenSkillsPrefix) {
  if (!entryName.startsWith(skillsPrefix)) return false;
  return Boolean(zip.file(`${hiddenSkillsPrefix}${entryName.slice(skillsPrefix.length)}`));
}

function legacyCompatibilityManifest(manifest) {
  if (manifest?.kind !== "lily-workspace-app") return manifest;
  return {
    ...manifest,
    kind: "lily-workspace-pack",
    originalKind: "lily-workspace-app",
  };
}

module.exports = {
  hasLegacyMirrorConflict,
  isLegacyFileMirrorEntry,
  isLegacySkillMirrorEntry,
  legacyCompatibilityManifest,
};
