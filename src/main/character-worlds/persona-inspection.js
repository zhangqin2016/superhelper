"use strict";

/**
 * Read-only persona inspection summaries (Phase 2B, Task P2B-2; design spec
 * §15/§16). Mirrors the world-book inspection discipline: NO narrative
 * content crosses the IPC bridge — the persona description stays in the main
 * process. The renderer receives ids, names, counts, enums, and hashes only.
 * Every builder is defensive against malformed stored data and never throws.
 */

const MAX_SUMMARY_ID_CHARS = 128;

function text(value, maximum = MAX_SUMMARY_ID_CHARS) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function descriptionOf(revision) {
  const canonical = revision?.canonical;
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return null;
  return typeof canonical.description === "string" ? canonical.description : null;
}

/** Entity summary shared by persona:list and persona:get. */
function summarizePersonaEntity(entity, currentRevision) {
  const description = currentRevision ? descriptionOf(currentRevision) : null;
  return {
    id: text(entity?.id),
    name: text(entity?.displayName, 256),
    currentRevisionId: text(entity?.currentRevisionId),
    archivedAt: typeof entity?.archivedAt === "string" ? entity.archivedAt : null,
    // null when the current revision row is missing/unreadable — the list
    // stays readable instead of failing the whole bridge call.
    descriptionChars: description ? [...description].length : null,
  };
}

/** Immutable revision metadata (provenance kind/format/container only). */
function summarizePersonaRevisionMetadata(revision) {
  const source = revision?.source && typeof revision.source === "object" ? revision.source : {};
  return {
    id: text(revision?.id),
    personaId: text(revision?.personaId),
    revisionNumber: count(revision?.revisionNumber),
    contentHash: text(revision?.contentHash, 128),
    revisionHash: text(revision?.revisionHash, 128),
    avatarAssetId: typeof revision?.avatarAssetId === "string" ? revision.avatarAssetId : null,
    source: {
      kind: text(source.kind),
      format: text(source.format),
      container: text(source.container),
    },
    createdAt: typeof revision?.createdAt === "string" ? revision.createdAt : null,
  };
}

/** persona:get detail: entity summary + revision metadata. */
function summarizePersonaDetail(entity, currentRevision) {
  return {
    ...summarizePersonaEntity(entity, currentRevision),
    revision: currentRevision ? summarizePersonaRevisionMetadata(currentRevision) : null,
  };
}

module.exports = {
  summarizePersonaDetail,
  summarizePersonaEntity,
  summarizePersonaRevisionMetadata,
};
