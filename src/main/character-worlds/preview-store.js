"use strict";

const { normalizeConversationConfig } = require("./conversation-config");
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
    if (facet === "persona") {
      const revision = this.repository.getPersonaRevision(ownerScope, revisionId);
      if (!revision) throw codedError("PERSONA_REVISION_NOT_FOUND", "Persona revision not found");
      return { entityId: revision.personaId, revisionId: revision.id };
    }
    throw codedError("CHARACTER_PREVIEW_INVALID", "Unsupported preview facet");
  }

  replaceFacet({ ownerScope, sessionId, expectedPreviewVersion, facet, revisionId }) {
    if (!FACETS.has(facet)) {
      throw codedError("CHARACTER_PREVIEW_INVALID", "Unsupported preview facet");
    }
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
    if (!BOOK_SCOPES.has(scope) || !MERGE_STRATEGIES.has(mergeStrategy)) {
      throw codedError("CHARACTER_PREVIEW_INVALID", "Invalid world book preview options");
    }
    const revision = this.repository.getWorldBookRevision(ownerScope, revisionId);
    if (!revision) {
      throw codedError("WORLD_BOOK_REVISION_NOT_FOUND", "World book revision not found");
    }
    const reference = {
      entityId: revision.worldBookId,
      revisionId: revision.id,
      scope,
      mergeStrategy,
    };
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      const worldBooks = current.worldBooks.filter((item) => (
        item.entityId !== reference.entityId && item.scope !== reference.scope
      ));
      worldBooks.push(reference);
      return this._write(ownerScope, sessionId, current, { ...current, worldBooks });
    })();
  }

  removeFacet({ ownerScope, sessionId, expectedPreviewVersion, facet, entityId = null }) {
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      if (FACETS.has(facet)) {
        return this._write(ownerScope, sessionId, current, { ...current, [facet]: null });
      }
      if (facet === "worldBook") {
        const worldBooks = entityId
          ? current.worldBooks.filter((item) => item.entityId !== entityId)
          : [];
        return this._write(ownerScope, sessionId, current, { ...current, worldBooks });
      }
      throw codedError("CHARACTER_PREVIEW_INVALID", "Unsupported preview facet");
    })();
  }

  clear({ ownerScope, sessionId, expectedPreviewVersion }) {
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      return this._write(ownerScope, sessionId, current, emptyPreview(current.previewVersion));
    })();
  }

  effectiveConfig({ ownerScope, sessionId, durableConfig }) {
    const durable = normalizeConversationConfig(configFields(durableConfig));
    const preview = this.get(ownerScope, sessionId);
    if (!preview) return durable;

    const character = preview.character
      && this.repository.getRevision(ownerScope, preview.character.revisionId);
    const persona = preview.persona
      && this.repository.getPersonaRevision(ownerScope, preview.persona.revisionId);
    let books = [...durable.books];
    for (const item of preview.worldBooks) {
      const revision = this.repository.getWorldBookRevision(ownerScope, item.revisionId);
      if (!revision || revision.worldBookId !== item.entityId) continue;
      books = books.filter((book) => {
        const durableRevision = this.repository.getWorldBookRevision(
          ownerScope,
          book.worldBookRevisionId,
        );
        return book.scope !== item.scope && durableRevision?.worldBookId !== item.entityId;
      });
      books.push({
        scope: item.scope,
        worldBookRevisionId: item.revisionId,
        mergeStrategy: item.mergeStrategy,
      });
    }
    return normalizeConversationConfig({
      ...durable,
      characterRevisionId: character?.id || durable.characterRevisionId,
      personaRevisionId: persona?.id || durable.personaRevisionId,
      books,
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
    return this.db.transaction(() => {
      const current = this._assertVersion(ownerScope, sessionId, expectedPreviewVersion);
      const durable = this.repository.getConversationConfig(sessionId, ownerScope);
      let nextConfig = normalizeConversationConfig(configFields(durable));
      let nextPreview;
      if (FACETS.has(facet)) {
        const reference = current[facet];
        if (!reference) throw codedError("CHARACTER_PREVIEW_NOT_FOUND", "Preview facet is unavailable");
        nextConfig = normalizeConversationConfig({
          ...nextConfig,
          [`${facet}RevisionId`]: reference.revisionId,
        });
        nextPreview = { ...current, [facet]: null };
      } else if (facet === "worldBook") {
        const selected = current.worldBooks.find((item) => !entityId || item.entityId === entityId);
        if (!selected) throw codedError("CHARACTER_PREVIEW_NOT_FOUND", "Preview world book is unavailable");
        const effective = this.effectiveConfig({ ownerScope, sessionId, durableConfig: durable });
        nextConfig = normalizeConversationConfig({
          ...configFields(durable),
          books: effective.books,
        });
        nextPreview = {
          ...current,
          worldBooks: current.worldBooks.filter((item) => item.entityId !== selected.entityId),
        };
      } else {
        throw codedError("CHARACTER_PREVIEW_INVALID", "Unsupported preview facet");
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
