"use strict";

const crypto = require("node:crypto");
const C = require("./constants");
const {
  configMode,
  emptyConversationConfig,
  normalizeConversationConfig,
} = require("./conversation-config");
const {
  projectCharacterCardBinding,
  projectCharacterCardConfig,
} = require("./character-card-only");
const { codedError, isoTime, stableJson } = require("./persistence-codec");

function envelope(config, binding, updatedAt) {
  return {
    schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
    bindingVersion: binding.bindingVersion,
    compatibilityProfileVersion: C.CHARACTER_COMPATIBILITY_PROFILE_VERSION,
    compatibilityProfile: binding.compatibilityProfile,
    mode: binding.mode,
    activeCharacterRevisionId: config.characterRevisionId,
    activePersonaRevisionId: config.personaRevisionId,
    activeGreetingIndex: config.greetingIndex,
    worldBookBindings: config.books,
    worldResolutionPolicy: { sourceMergeStrategy: "sorted_evenly" },
    sceneId: config.sceneId,
    groupSceneId: config.groupId,
    effectiveAfterTurnId: null,
    updatedAt,
  };
}

function readEnvelope(row) {
  if (!row || typeof row.binding_json !== "string") return null;
  try {
    const value = JSON.parse(row.binding_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function getConversationConfig(repository, sessionId, ownerScope) {
  const binding = repository.getBinding(sessionId, ownerScope);
  const row = repository.db.get(
    "SELECT binding_json FROM character_session_bindings WHERE session_id = ? AND owner_scope = ?",
    sessionId, ownerScope,
  );
  const stored = readEnvelope(row);
  const config = projectCharacterCardConfig({
    characterRevisionId: binding.characterRevisionId,
    personaRevisionId: binding.personaRevisionId,
    books: repository.getBookBindings(sessionId, ownerScope),
    greetingIndex: binding.greetingIndex,
    sceneId: stored?.sceneId || null,
    groupId: stored?.groupSceneId || null,
  });
  return {
    ...projectCharacterCardBinding(binding),
    books: config.books,
    sceneId: config.sceneId,
    groupId: config.groupId,
  };
}

function validatePins(repository, ownerScope, config) {
  const exists = (table, revisionId) => repository.db.get(
    `SELECT 1 AS present FROM ${table} WHERE id = ? AND owner_scope = ?`,
    revisionId,
    ownerScope,
  );
  if (config.characterRevisionId && !exists("character_revisions", config.characterRevisionId)) {
    throw codedError("CHARACTER_REVISION_NOT_FOUND", "Character revision not found");
  }
  if (config.personaRevisionId && !exists("persona_revisions", config.personaRevisionId)) {
    throw codedError("PERSONA_REVISION_NOT_FOUND", "Persona revision not found");
  }
  for (const book of config.books) {
    if (!exists("world_book_revisions", book.worldBookRevisionId)) {
      throw codedError("WORLD_BOOK_REVISION_NOT_FOUND", "World book revision not found");
    }
  }
}

function replaceBooks(repository, sessionId, ownerScope, books, createdAt) {
  repository.db.run(
    "DELETE FROM character_session_book_bindings WHERE session_id = ? AND owner_scope = ?",
    sessionId, ownerScope,
  );
  for (const book of books) {
    repository.db.run(
      `INSERT INTO character_session_book_bindings
         (session_id, owner_scope, scope, world_book_revision_id, merge_strategy, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId, ownerScope, book.scope, book.worldBookRevisionId,
      book.mergeStrategy, isoTime(createdAt),
    );
  }
}

function setConversationConfig(repository, {
  sessionId,
  ownerScope,
  expectedBindingVersion,
  next,
  clearPreview = false,
  compatibilityProfile = null,
}) {
  if (!Number.isInteger(expectedBindingVersion) || expectedBindingVersion < 0) {
    throw new TypeError("expectedBindingVersion must be a non-negative integer");
  }
  const config = projectCharacterCardConfig(
    normalizeConversationConfig(next || emptyConversationConfig()),
  );
  validatePins(repository, ownerScope, config);

  return repository.db.transaction(() => {
    const row = repository.db.get(
      "SELECT * FROM character_session_bindings WHERE session_id = ?",
      sessionId,
    );
    if (row && row.owner_scope !== ownerScope) {
      throw codedError(
        "CHARACTER_BINDING_OWNER_MISMATCH",
        "Session binding belongs to another owner scope",
      );
    }
    const current = repository.getBinding(sessionId, ownerScope);
    const currentBooks = repository.getBookBindings(sessionId, ownerScope);
    if (current.bindingVersion !== expectedBindingVersion) {
      throw codedError("CHARACTER_BINDING_CONFLICT", "Binding version is stale", { current });
    }

    const mode = configMode(config);
    const profile = mode === "character"
      ? String(
          compatibilityProfile
          || (current.characterRevisionId === config.characterRevisionId
            ? current.compatibilityProfile
            : "")
          || C.CHARACTER_COMPATIBILITY_PROFILE,
        )
      : null;
    const createdAt = Date.now();
    const updatedAt = isoTime(createdAt);
    const committed = {
      schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
      sessionId,
      mode,
      bindingVersion: current.bindingVersion + 1,
      characterRevisionId: config.characterRevisionId,
      personaRevisionId: config.personaRevisionId,
      compatibilityProfile: profile,
      greetingIndex: config.greetingIndex,
      books: config.books,
      sceneId: config.sceneId,
      groupId: config.groupId,
    };
    const nextEnvelope = envelope(config, committed, updatedAt);
    const envelopeJson = stableJson(nextEnvelope);
    if (Buffer.byteLength(envelopeJson, "utf8") > C.MAX_CHARACTER_BINDING_BYTES) {
      throw codedError(
        "CHARACTER_BINDING_TOO_LARGE",
        `Binding exceeds ${C.MAX_CHARACTER_BINDING_BYTES} bytes`,
      );
    }

    repository.db.run(
      `INSERT INTO character_session_bindings
         (session_id, owner_scope, binding_version, mode,
          character_revision_id, persona_revision_id, compatibility_profile,
          binding_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         binding_version = excluded.binding_version,
         mode = excluded.mode,
         character_revision_id = excluded.character_revision_id,
         persona_revision_id = excluded.persona_revision_id,
         compatibility_profile = excluded.compatibility_profile,
         binding_json = excluded.binding_json,
         updated_at = excluded.updated_at`,
      sessionId, ownerScope, committed.bindingVersion, mode,
      config.characterRevisionId, config.personaRevisionId, profile,
      envelopeJson, createdAt,
    );
    replaceBooks(repository, sessionId, ownerScope, config.books, createdAt);

    const previousConfig = row
      ? projectCharacterCardConfig({
          characterRevisionId: current.characterRevisionId,
          personaRevisionId: current.personaRevisionId,
          books: currentBooks,
          greetingIndex: current.greetingIndex,
          sceneId: readEnvelope(row)?.sceneId || null,
          groupId: readEnvelope(row)?.groupSceneId || null,
        })
      : emptyConversationConfig();
    const previousEnvelope = readEnvelope(row)
      || envelope(previousConfig, current, row ? isoTime(row.updated_at) : null);
    const eventId = crypto.randomUUID();
    const event = {
      schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
      id: eventId,
      sessionId,
      type: "character_binding.changed",
      previousBinding: previousEnvelope,
      nextBinding: nextEnvelope,
      effectiveAfterTurnId: null,
      createdAt: updatedAt,
    };
    repository.db.run(
      `INSERT INTO character_binding_events
         (id, session_id, owner_scope, binding_version, event_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      eventId, sessionId, ownerScope, committed.bindingVersion,
      stableJson(event), createdAt,
    );
    if (clearPreview) {
      repository.db.run(
        "DELETE FROM character_session_previews WHERE session_id = ? AND owner_scope = ?",
        sessionId, ownerScope,
      );
    }
    return committed;
  })();
}

module.exports = { getConversationConfig, setConversationConfig };
