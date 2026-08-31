"use strict";

const packCompat = require("./workspace-pack-compat");

// Shared by ordinary and collaboration imports so root/legacy compatibility
// mirrors have exactly one extraction selection rule.
function selectImportEntries(zip, {
  layout,
  filesPrefix,
  packMetaPrefix,
  manifestName,
  conventionsEntry,
  skillsPrefix,
  packSkillsPrefix,
}) {
  const legacyEntries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith(filesPrefix));
  return layout === "legacy"
    ? legacyEntries.map((entry) => ({ entry, rel: entry.name.slice(filesPrefix.length) }))
    : Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .filter((entry) => !entry.name.startsWith(packMetaPrefix))
      .filter((entry) => entry.name !== manifestName && entry.name !== conventionsEntry)
      .filter((entry) => !packCompat.isLegacyFileMirrorEntry(entry.name, zip, filesPrefix))
      .filter((entry) => !packCompat.isLegacySkillMirrorEntry(entry.name, zip, skillsPrefix, packSkillsPrefix))
      .map((entry) => ({ entry, rel: entry.name }));
}

// Preserve the archive insertion ordering used by the established importer.
// Callers decide whether mirrored destinations are counted once or written in
// their legacy-compatible sequence.
function selectWorkspaceSkillEntries(zip, { skillIds, skillsPrefix, packSkillsPrefix }) {
  const ids = new Set(skillIds);
  if (!ids.size) return [];
  return Object.values(zip.files).flatMap((entry) => {
    if (entry.dir) return [];
    const prefix = entry.name.startsWith(packSkillsPrefix)
      ? packSkillsPrefix
      : entry.name.startsWith(skillsPrefix)
        ? skillsPrefix
        : "";
    if (!prefix) return [];
    const rest = entry.name.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return [];
    const skillId = rest.slice(0, slash);
    const rel = rest.slice(slash + 1);
    return ids.has(skillId) && rel ? [{ entry, skillId, rel }] : [];
  });
}

module.exports = { selectImportEntries, selectWorkspaceSkillEntries };
