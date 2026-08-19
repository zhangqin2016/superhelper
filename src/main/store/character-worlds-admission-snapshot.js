"use strict";

const {
  CHARACTER_COMPATIBILITY_PROFILE,
  MAX_CHARACTER_BINDING_BYTES,
} = require("../character-worlds/constants");
const {
  fallbackSnapshot,
  readySnapshot,
  readyCompositionSnapshot,
} = require("../character-worlds/turn-binding-snapshot");
const { parsePreview } = require("../character-worlds/preview-store");
const { projectCharacterCardSnapshot } = require("../character-worlds/character-card-only");

function parseEnvelope(row) {
  if (
    !row
    || typeof row.binding_json !== "string"
    || Buffer.byteLength(row.binding_json, "utf8") > MAX_CHARACTER_BINDING_BYTES
  ) return null;
  try {
    const value = JSON.parse(row.binding_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function validBindingRow(row, envelope) {
  if (!row || !envelope || !Number.isInteger(row.binding_version) || row.binding_version < 1) {
    return false;
  }
  return envelope.schemaVersion === 1
    && envelope.bindingVersion === row.binding_version
    && envelope.mode === row.mode
    && (envelope.activeCharacterRevisionId || null) === (row.character_revision_id || null)
    && (envelope.activePersonaRevisionId || null) === (row.persona_revision_id || null)
    && (envelope.compatibilityProfile || null) === (row.compatibility_profile || null)
    && (
      (row.mode === "native" && row.character_revision_id == null && row.compatibility_profile == null)
      || (row.mode === "character" && row.character_revision_id && row.compatibility_profile)
    );
}

function revisionEntity(db, table, revisionId, ownerScope) {
  if (!revisionId) return null;
  return db.get(
    `SELECT id, entity_id FROM ${table} WHERE id = ? AND owner_scope = ?`,
    revisionId, ownerScope,
  ) || null;
}

function currentConversationSnapshot(db, sessionId, ownerScope) {
  if (typeof ownerScope !== "string" || !ownerScope) return null;
  const row = db.get(
    `SELECT * FROM character_session_bindings
     WHERE session_id = ? AND owner_scope = ?`,
    sessionId, ownerScope,
  );
  const previewRow = db.get(
    `SELECT preview_version, preview_json FROM character_session_previews
     WHERE session_id = ? AND owner_scope = ?`,
    sessionId, ownerScope,
  );
  if (!row && !previewRow) {
    const foreign = db.get(
      "SELECT 1 AS present FROM character_session_bindings WHERE session_id = ? LIMIT 1",
      sessionId,
    );
    return foreign ? fallbackSnapshot() : null;
  }

  const envelope = row ? parseEnvelope(row) : null;
  if (row && !validBindingRow(row, envelope)) return fallbackSnapshot();
  let characterRevisionId = row?.character_revision_id || null;
  let personaRevisionId = null;
  let compatibilityProfile = row?.compatibility_profile || null;
  let greetingIndex = Number.isSafeInteger(envelope?.activeGreetingIndex)
    ? envelope.activeGreetingIndex
    : null;
  let sceneId = typeof envelope?.sceneId === "string" ? envelope.sceneId : null;
  let groupId = typeof envelope?.groupSceneId === "string" ? envelope.groupSceneId : null;
  let books = db.all(
    `SELECT scope, world_book_revision_id, merge_strategy
     FROM character_session_book_bindings
     WHERE session_id = ? AND owner_scope = ? ORDER BY rowid`,
    sessionId, ownerScope,
  ).map((book) => ({
    scope: book.scope,
    worldBookRevisionId: book.world_book_revision_id,
    mergeStrategy: book.merge_strategy || "constant",
  }));
  // Legacy persona/world-book rows remain in storage for compatibility, but
  // the live product is character-card-only. Never carry them into a turn.
  books = [];

  if (characterRevisionId && !revisionEntity(
    db, "character_revisions", characterRevisionId, ownerScope,
  )) return fallbackSnapshot();

  const preview = parsePreview(previewRow);
  if (preview?.character) {
    const revision = revisionEntity(
      db, "character_revisions", preview.character.revisionId, ownerScope,
    );
    if (revision?.entity_id === preview.character.entityId) {
      characterRevisionId = revision.id;
      compatibilityProfile = CHARACTER_COMPATIBILITY_PROFILE;
      greetingIndex = null;
      sceneId = null;
      groupId = null;
    }
  }
  return projectCharacterCardSnapshot({
    schemaVersion: 2,
    mode: characterRevisionId ? "character" : "native",
    bindingVersion: row?.binding_version || 0,
    previewVersion: preview?.previewVersion || 0,
    characterRevisionId,
    personaRevisionId: null,
    worldBookBindings: [],
    compatibilityProfile: characterRevisionId ? compatibilityProfile || CHARACTER_COMPATIBILITY_PROFILE : null,
    greetingIndex,
    sceneId,
    groupId,
  });
}

module.exports = { currentConversationSnapshot };
