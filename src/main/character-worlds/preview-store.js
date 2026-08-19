"use strict";

const { normalizeConversationConfig } = require("./conversation-config");
const { projectCharacterCardConfig } = require("./character-card-only");
const { codedError, stableJson } = require("./persistence-codec");

const FACETS = new Set(["character", "persona"]);
const BOOK_SCOPES = new Set(["chat", "persona", "character", "global"]);
const MERGE_STRATEGIES = new Set(["constant", "keyed"]);

function emptyPreview(previewVersion = 0) {
  return {
    previewVersion,
    character: null,
    persona: null,
    worldBooks: [],
  };
}

function safeReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entityId = typeof value.entityId === "string" ? value.entityId : "";
  const revisionId = typeof value.revisionId === "string" ? value.revisionId : "";
  return entityId && revisionId ? { entityId, revisionId } : null;
}

function parsePreview(row) {
  if (!row) return null;
  let value;
  try {
    value = JSON.parse(row.preview_json);
  } catch {
    value = {};
  }
  const worldBooks = [];
  for (const item of Array.isArray(value?.worldBooks) ? value.worldBooks : []) {
    const reference = safeReference(item);
    const scope = BOOK_SCOPES.has(item?.scope) ? item.scope : null;
    const mergeStrategy = MERGE_STRATEGIES.has(item?.mergeStrategy)
      ? item.mergeStrategy
      : null;
    if (reference && scope && mergeStrategy && worldBooks.length < BOOK_SCOPES.size) {
      worldBooks.push({ ...reference, scope, mergeStrategy });
    }
  }
  return {
    previewVersion: Number.isSafeInteger(row.preview_version) && row.preview_version > 0
      ? row.preview_version
      : 0,
    character: safeReference(value?.character),
    persona: safeReference(value?.persona),
    worldBooks,
  };
}

function serialized(preview) {
  return stableJson({
    character: preview.character,
    persona: preview.persona,
    worldBooks: preview.worldBooks,
  });
}

function configFields(value = {}) {
  return {
    characterRevisionId: value.characterRevisionId ?? null,
    personaRevisionId: value.personaRevisionId ?? null,
    books: value.books || [],
    greetingIndex: value.greetingIndex ?? null,
    sceneId: value.sceneId ?? null,
    groupId: value.groupId ?? null,
  };
}

class CharacterPreviewStore {
  constructor({ repository, now = Date.now } = {}) {
    if (!repository?.db || typeof repository.getConversationConfig !== "function") {
      throw new TypeError("CharacterPreviewStore requires CharacterWorldsRepository");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.repository = repository;
    this.db = repository.db;
    this.now = now;
  }

  get(ownerScope, sessionId) {
    return parsePreview(this.db.get(
      `SELECT preview_version, preview_json
       FROM character_session_previews
       WHERE session_id = ? AND owner_scope = ?`,
      sessionId, ownerScope,
    ));
  }

  _current(ownerScope, sessionId) {
    return this.get(ownerScope, sessionId) || emptyPreview();
  }

  _assertVersion(ownerScope, sessionId, expectedPreviewVersion) {
    if (!Number.isInteger(expectedPreviewVersion) || expectedPreviewVersion < 0) {
      throw new TypeError("expectedPreviewVersion must be a non-negative integer");
    }
    const current = this._current(ownerScope, sessionId);
    if (current.previewVersion !== expectedPreviewVersion) {
      throw codedError("CHARACTER_PREVIEW_CONFLICT", "Preview version is stale", { current });
    }
    return current;
  }

  _write(ownerScope, sessionId, current, next) {
    const now = Number(this.now()) || Date.now();
    const committed = {
      ...next,
      previewVersion: current.previewVersion + 1,
    };
    this.db.run(
      `INSERT INTO character_session_previews
         (session_id, owner_scope, preview_version, preview_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, owner_scope) DO UPDATE SET
         preview_version = excluded.preview_version,
         preview_json = excluded.preview_json,
         updated_at = excluded.updated_at`,
      sessionId, ownerScope, committed.previewVersion, serialized(committed), now, now,
    );
    return committed;
  }

  _reference(ownerScope, facet, revisionId) {
    if (facet === "character") {
      const revision = this.repository.getRevision(ownerScope, revisionId);
      if (!revision) throw codedError("CHARACTER_REVISION_NOT_FOUND", "Character revision not found");
      return { entityId: revision.characterId, revisionId: revision.id };
    }
    throw codedError("FEATURE_DISABLED", "Only character cards are supported");
  }

  replaceFacet({ ownerScope, sessionId, expectedPreviewVersion, facet, revisionId }) {
    if (facet !== "character") throw codedError("FEATURE_DISABLED", "Only character cards are supported");
    const reference = this._reference(ownerScope, facet, revisionId);
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      return this._write(ownerScope, sessionId, current, { ...current, [facet]: reference });
    })();
  }

  addWorldBook({
    ownerScope,
    sessionId,
    expectedPreviewVersion,
    revisionId,
    scope = "chat",
    mergeStrategy = "constant",
  }) {
    throw codedError("FEATURE_DISABLED", "World books are disabled");
  }

  removeFacet({ ownerScope, sessionId, expectedPreviewVersion, facet, entityId = null }) {
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      if (facet === "character") {
        return this._write(ownerScope, sessionId, current, { ...current, [facet]: null });
      }
      throw codedError("FEATURE_DISABLED", "Only character cards are supported");
    })();
  }

  clear({ ownerScope, sessionId, expectedPreviewVersion }) {
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      return this._write(ownerScope, sessionId, current, emptyPreview(current.previewVersion));
    })();
  }

  effectiveConfig({ ownerScope, sessionId, durableConfig }) {
    const durable = projectCharacterCardConfig(configFields(durableConfig));
    const preview = this.get(ownerScope, sessionId);
    if (!preview) return durable;

    const character = preview.character
      && this.repository.getRevision(ownerScope, preview.character.revisionId);
    return projectCharacterCardConfig({
      ...durable,
      characterRevisionId: character?.id || durable.characterRevisionId,
    });
  }

  activateFacet({
    ownerScope,
    sessionId,
    expectedPreviewVersion,
    expectedBindingVersion,
    facet,
    entityId = null,
  }) {
    if (facet !== "character") throw codedError("FEATURE_DISABLED", "Only character cards are supported");
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      const durable = this.repository.getConversationConfig(sessionId, ownerScope);
      let nextConfig = normalizeConversationConfig(configFields(durable));
      let nextPreview;
      if (facet === "character") {
        const reference = current[facet];
        if (!reference) throw codedError("CHARACTER_PREVIEW_NOT_FOUND", "Preview facet is unavailable");
        nextConfig = normalizeConversationConfig({
          ...nextConfig,
          [`${facet}RevisionId`]: reference.revisionId,
        });
        nextPreview = { ...current, [facet]: null };
      } else {
        throw codedError("FEATURE_DISABLED", "Only character cards are supported");
      }
      const binding = this.repository.setConversationConfig({
        sessionId,
        ownerScope,
        expectedBindingVersion,
        next: nextConfig,
      });
      const preview = this._write(ownerScope, sessionId, current, nextPreview);
      return { binding, preview };
    })();
  }
}

module.exports = { CharacterPreviewStore, emptyPreview, parsePreview };
