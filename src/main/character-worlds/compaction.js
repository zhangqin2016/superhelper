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
  "previewVersion",
  "characterRevisionId",
  "personaRevisionId",
  "worldBookRevisionIds",
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
  const characterRevisionId = typeof snapshot.characterRevisionId === "string"
    ? snapshot.characterRevisionId
    : null;
  const personaRevisionId = typeof snapshot.personaRevisionId === "string"
    ? snapshot.personaRevisionId
    : null;
  const worldBookRevisionIds = Array.isArray(snapshot.worldBookBindings)
    ? snapshot.worldBookBindings
      .map((binding) => typeof binding?.worldBookRevisionId === "string"
        ? binding.worldBookRevisionId
        : null)
      .filter(Boolean)
      .slice(0, 32)
    : [];
  if (!characterRevisionId && !personaRevisionId && worldBookRevisionIds.length === 0) return null;
  const section = {
    schemaVersion: snapshot.schemaVersion === 2 ? 2 : 1,
    mode: characterRevisionId ? "character" : "native",
    bindingVersion: Number.isInteger(snapshot.bindingVersion)
      ? snapshot.bindingVersion
      : 0,
    characterRevisionId: characterRevisionId || "",
    personaRevisionId,
    compatibilityProfile: typeof snapshot.compatibilityProfile === "string"
      ? snapshot.compatibilityProfile
      : null,
  };
  if (section.schemaVersion === 2) {
    section.previewVersion = Number.isInteger(snapshot.previewVersion) ? snapshot.previewVersion : 0;
    section.worldBookRevisionIds = Object.freeze(worldBookRevisionIds);
    if (!characterRevisionId) section.characterRevisionId = null;
  }
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
    (value.mode === "character" || value.mode === "native") &&
    (value.characterRevisionId === null || typeof value.characterRevisionId === "string") &&
    (value.personaRevisionId === null || typeof value.personaRevisionId === "string") &&
    (value.worldBookRevisionIds === undefined || (
      Array.isArray(value.worldBookRevisionIds)
      && value.worldBookRevisionIds.every((id) => typeof id === "string" && id.length > 0)
    )) &&
    Boolean(value.characterRevisionId || value.personaRevisionId || value.worldBookRevisionIds?.length) &&
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
  const character = section.characterRevisionId
    ? `character ${section.characterRevisionId.slice(0, 8)}`
    : "native Lily";
  const books = section.worldBookRevisionIds?.length
    ? `, books ${section.worldBookRevisionIds.map((id) => id.slice(0, 8)).join("/")}`
    : "";
  return `Character Worlds: active binding v${section.bindingVersion} ` +
    `(${character}${persona}${books})`;
}

module.exports = {
  CHARACTER_WORLDS_SUMMARY_KEYS,
  MAX_SUMMARY_SECTION_BYTES,
  characterWorldsSummarySection,
  formatCharacterWorldsSummary,
  isMetadataOnlyCharacterSection,
  SNAPSHOT_SCHEMA_VERSION: C.SNAPSHOT_SCHEMA_VERSION,
};
