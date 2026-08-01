"use strict";

/**
 * Character Worlds compaction integration (design spec §10.5).
 *
 * Compaction summaries may record factual conversation state and
 * character-switch events, but they MUST NOT promote old card instructions
 * into permanent policy and MUST NOT resurrect an old role after a later
 * switch. This module gives the compaction runtime a METADATA-ONLY character
 * section: the current active binding (mode/version/revision ids), rendered
 * into the session summary as a bounded, deterministic line. Card text,
 * macros, executable keys, world lore, and persona text never enter the
 * section — the allowed-key whitelist below is the guard, and every consumer
 * checks it before rendering.
 */

const C = require("./constants");

const CHARACTER_WORLDS_SUMMARY_KEYS = new Set([
  "schemaVersion",
  "mode",
  "bindingVersion",
  "characterRevisionId",
  "personaRevisionId",
  "compatibilityProfile",
]);

const MAX_SUMMARY_SECTION_BYTES = 1024;

/**
 * Build the bounded, metadata-only character section for a session summary
 * from the admission snapshot. Returns null when the snapshot is absent or
 * native (nothing character-related happened, so nothing is recorded).
 * @param {object|null|undefined} snapshot normalized characterWorlds snapshot
 * @returns {object|null} frozen metadata-only section
 */
function characterWorldsSummarySection(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (snapshot.mode !== "character") return null;
  const section = {
    schemaVersion: 1,
    mode: snapshot.mode,
    bindingVersion: Number.isInteger(snapshot.bindingVersion)
      ? snapshot.bindingVersion
      : 0,
    characterRevisionId: typeof snapshot.characterRevisionId === "string"
      ? snapshot.characterRevisionId
      : "",
    personaRevisionId: typeof snapshot.personaRevisionId === "string"
      ? snapshot.personaRevisionId
      : null,
    compatibilityProfile: typeof snapshot.compatibilityProfile === "string"
      ? snapshot.compatibilityProfile
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(section), "utf8") > MAX_SUMMARY_SECTION_BYTES) {
    return null;
  }
  return Object.freeze(section);
}

/**
 * Metadata-only guard: a section is valid only when every key is whitelisted
 * and no value carries card content. Consumers (renderer + tests) reject any
 * section that fails — this is what stops card instructions from leaking into
 * summaries via future edits.
 * @param {unknown} value
 * @returns {boolean}
 */
function isMetadataOnlyCharacterSection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const key of Object.keys(value)) {
    if (!CHARACTER_WORLDS_SUMMARY_KEYS.has(key)) return false;
  }
  return (
    value.mode === "character" &&
    typeof value.characterRevisionId === "string" &&
    value.characterRevisionId.length > 0 &&
    typeof value.bindingVersion === "number" &&
    Number.isInteger(value.bindingVersion)
  );
}

/**
 * Render the section as one bounded line for the session summary. The line
 * records WHICH binding is active (metadata only) so a compaction summary can
 * distinguish the current active binding from historical segments without
 * ever carrying role instructions.
 * @param {object|null} section
 * @returns {string}
 */
function formatCharacterWorldsSummary(section) {
  if (!isMetadataOnlyCharacterSection(section)) return "";
  const persona = section.personaRevisionId ? `, persona ${section.personaRevisionId.slice(0, 8)}` : "";
  return `Character Worlds: active binding v${section.bindingVersion} ` +
    `(character ${section.characterRevisionId.slice(0, 8)}${persona})`;
}

module.exports = {
  CHARACTER_WORLDS_SUMMARY_KEYS,
  MAX_SUMMARY_SECTION_BYTES,
  characterWorldsSummarySection,
  formatCharacterWorldsSummary,
  isMetadataOnlyCharacterSection,
  SNAPSHOT_SCHEMA_VERSION: C.SNAPSHOT_SCHEMA_VERSION,
};
