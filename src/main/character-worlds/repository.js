"use strict";
const crypto = require("node:crypto");
const C = require("./constants");
const { CharacterAssetLifecycle } = require("./asset-lifecycle");
const {
  findImportDuplicates,
  importCharacter,
} = require("./import-repository");
const {
  archiveWorldBook,
  createWorldBook,
  createWorldBookRevision,
  getWorldBook,
  getWorldBookRevision,
  listWorldBooks,
} = require("./world-book-repository");
const {
  archivePersona,
  createPersona,
  createPersonaRevision,
  getPersona,
  getPersonaRevision,
  listPersonas,
} = require("./persona-repository");
const {
  readWorldBookCheckpoint,
  writeWorldBookCheckpoint,
  deleteWorldBookCheckpointsForSession,
} = require("./world-book-checkpoint-store");
const {
  codedError,
  isoTime,
  prepareRevision,
  requiredString,
  stableJson,
  unpackJson,
} = require("./persistence-codec");
const {
  getConversationConfig,
  setConversationConfig,
} = require("./conversation-config-repository");
function entityFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: C.CHARACTER_SCHEMA_VERSION,
    id: row.id,
    ownerScope: row.owner_scope,
    displayName: row.display_name,
    currentRevisionId: row.current_revision_id,
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    archivedAt: isoTime(row.archived_at),
  };
}
function nativeBinding(sessionId, bindingVersion = 0) {
  return {
    schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
    sessionId,
    mode: "native",
    bindingVersion,
    characterRevisionId: null,
    personaRevisionId: null,
    compatibilityProfile: null,
    greetingIndex: null,
  };
}
function bindingFromRow(row, sessionId) {
  if (!row) return nativeBinding(sessionId);
  let greetingIndex = null;
  try {
    const envelope = typeof row.binding_json === "string" ? JSON.parse(row.binding_json) : null;
    const idx = envelope?.activeGreetingIndex;
    if (Number.isSafeInteger(idx) && idx >= 0) greetingIndex = idx;
  } catch {
    greetingIndex = null;
  }
  return {
    schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
    sessionId,
    mode: row.mode,
    bindingVersion: row.binding_version,
    characterRevisionId: row.character_revision_id || null,
    personaRevisionId: row.persona_revision_id || null,
    compatibilityProfile: row.compatibility_profile || null,
    greetingIndex,
  };
}
function bindingEnvelope(binding, updatedAt) {
  return {
    schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
    bindingVersion: binding.bindingVersion,
    compatibilityProfileVersion: C.CHARACTER_COMPATIBILITY_PROFILE_VERSION,
    compatibilityProfile: binding.compatibilityProfile,
    mode: binding.mode,
    activeCharacterRevisionId: binding.characterRevisionId,
    activePersonaRevisionId: binding.personaRevisionId || null,
    activeGreetingIndex: Number.isSafeInteger(binding.greetingIndex) && binding.greetingIndex >= 0
      ? binding.greetingIndex
      : null,
    worldBookBindings: [],
    worldResolutionPolicy: { sourceMergeStrategy: "sorted_evenly" },
    groupSceneId: null,
    effectiveAfterTurnId: null,
    updatedAt,
  };
}
class CharacterWorldsRepository {
  constructor(messageStore) {
    if (!messageStore?.db || !messageStore?.blobs)
      throw new TypeError("CharacterWorldsRepository requires MessageStore");
    this.db = messageStore.db;
    this.blobs = messageStore.blobs;
    this.assetLifecycle = new CharacterAssetLifecycle(this.db, this.blobs);
    try {
      this.assetLifecycle.reconcile();
    } catch {
      // Reconciliation is maintenance; repository availability must fail open.
    }
  }
  _linkRevisionAssets(revisionId, owner, assets, createdAt) {
    for (const asset of assets) {
      this.db.run(
        `INSERT OR IGNORE INTO blobs (hash, bytes, mime, refcount, created_at)
         VALUES (?, ?, ?, 0, ?)`,
        asset.hash, asset.bytes, asset.mime, createdAt,
      );
      const linked = this.db.run(
        `INSERT OR IGNORE INTO character_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
        revisionId, owner, asset.hash, asset.bytes, asset.mime, asset.purpose,
      );
      if (linked.changes > 0)
        this.db.run("UPDATE blobs SET refcount = refcount + 1 WHERE hash = ?", asset.hash);
    }
  }
  _insertRevision({ id, entityId, owner, parentId, number, prepared, createdAt, characterBookRevisionId = null }) {
    this.db.run(
      `INSERT INTO character_revisions
         (id, entity_id, owner_scope, parent_revision_id, revision_number,
          display_name, source_kind, source_format, source_container,
          canonical_json, source_json, canonical_hash, original_hash,
          revision_hash, character_book_revision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, entityId, owner, parentId, number,
      prepared.displayName, prepared.sourceValue.kind, prepared.sourceValue.format,
      prepared.sourceValue.container, prepared.canonicalData.packed,
      prepared.sourceData.packed, prepared.canonicalHash, prepared.originalHash,
      prepared.revisionHash, characterBookRevisionId, createdAt,
    );
  }
  _updateCurrent(entityId, owner, revisionId, displayName, updatedAt) {
    this.db.run(
      `UPDATE character_entities
       SET display_name = ?, current_revision_id = ?, updated_at = ?
       WHERE id = ? AND owner_scope = ?`,
      displayName, revisionId, updatedAt, entityId, owner,
    );
  }
  _revisionState(owner, entityId, baseRevisionId, revisionHash) {
    const current = this.db.get(
      "SELECT * FROM character_entities WHERE id = ? AND owner_scope = ?",
      entityId, owner,
    );
    if (!current) throw codedError("CHARACTER_NOT_FOUND", "Character not found");
    if (current.current_revision_id !== baseRevisionId) {
      throw codedError("CHARACTER_REVISION_CONFLICT", "Character revision is stale", {
        currentRevisionId: current.current_revision_id });
    }
    const duplicate = this.db.get(
      `SELECT * FROM character_revisions
       WHERE owner_scope = ? AND entity_id = ? AND revision_hash = ?`,
      owner, entityId, revisionHash,
    );
    return { current, duplicate };
  }
  _useDuplicate(state, entityId, owner, prepared, updatedAt) {
    if (state.duplicate.id !== state.current.current_revision_id)
      this._updateCurrent(entityId, owner, state.duplicate.id,
        prepared.displayName, updatedAt);
    return this._revisionFromRow(state.duplicate);
  }
  _revisionFromRow(row) {
    if (!row) return null;
    const cardAssets = this.db.all(
      `SELECT hash, bytes, mime, purpose FROM character_revision_blobs rb
       WHERE rb.revision_id = ? AND rb.owner_scope = ?
       ORDER BY rb.purpose ASC, rb.hash ASC`,
      row.id, row.owner_scope,
    ).map((asset) => ({
      hash: asset.hash, bytes: asset.bytes, mime: asset.mime, purpose: asset.purpose,
    }));
    return {
      schemaVersion: C.CHARACTER_SCHEMA_VERSION,
      id: row.id,
      characterId: row.entity_id,
      ownerScope: row.owner_scope,
      parentRevisionId: row.parent_revision_id || null,
      revisionNumber: row.revision_number,
      displayName: row.display_name,
      contentHash: row.canonical_hash,
      revisionHash: row.revision_hash,
      source: unpackJson(row.source_json),
      canonical: unpackJson(row.canonical_json),
      cardAssets,
      characterBookRevisionId: row.character_book_revision_id || null,
      createdAt: isoTime(row.created_at),
    };
  }
  findImportDuplicates(ownerScope, hashes) {
    return findImportDuplicates(this, ownerScope, hashes);
  }
  importCharacter(input) {
    return importCharacter(this, input);
  }
  createWorldBook(input) {
    return createWorldBook(this, input);
  }
  createWorldBookRevision(input) {
    return createWorldBookRevision(this, input);
  }
  listWorldBooks(ownerScope, options) {
    return listWorldBooks(this, ownerScope, options);
  }
  getWorldBook(ownerScope, entityId) {
    return getWorldBook(this, ownerScope, entityId);
  }
  getWorldBookRevision(ownerScope, revisionId) {
    return getWorldBookRevision(this, ownerScope, revisionId);
  }
  archiveWorldBook(ownerScope, entityId) {
    return archiveWorldBook(this, ownerScope, entityId);
  }
  createPersona(input) {
    return createPersona(this, input);
  }
  createPersonaRevision(input) {
    return createPersonaRevision(this, input);
  }
  listPersonas(ownerScope, options) {
    return listPersonas(this, ownerScope, options);
  }
  getPersona(ownerScope, entityId) {
    return getPersona(this, ownerScope, entityId);
  }
  getPersonaRevision(ownerScope, revisionId) {
    return getPersonaRevision(this, ownerScope, revisionId);
  }
  archivePersona(ownerScope, entityId) {
    return archivePersona(this, ownerScope, entityId);
  }
  readWorldBookCheckpoint(input) {
    return readWorldBookCheckpoint(this, input);
  }
  writeWorldBookCheckpoint(input) {
    return writeWorldBookCheckpoint(this, input);
  }
  deleteWorldBookCheckpointsForSession(ownerScope, sessionId) {
    return deleteWorldBookCheckpointsForSession(this, ownerScope, sessionId);
  }
  createCharacter({ ownerScope, canonical, source, assets = [], characterBookRevisionId = null }) {
    const owner = requiredString(ownerScope, "ownerScope");
    const assetRefs = this.assetLifecycle.prepare(assets);
    const prepared = prepareRevision(canonical, source, "created", assetRefs);
    const entityId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const createdAt = Date.now();
    return this.assetLifecycle.writeForMutation(assetRefs, () => (
      this.db.transaction(() => {
        this._insertRevision({
          id: revisionId, entityId, owner, parentId: null, number: 1, prepared, createdAt,
          characterBookRevisionId,
        });
        this.db.run(
          `INSERT INTO character_entities
             (id, owner_scope, display_name, current_revision_id, archived_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          entityId, owner, prepared.displayName, revisionId, createdAt, createdAt,
        );
        this._linkRevisionAssets(revisionId, owner, assetRefs, createdAt);
        return {
          entity: this.getCharacter(owner, entityId),
          revision: this.getRevision(owner, revisionId),
        };
      })()
    ));
  }
  createRevision({ ownerScope, entityId, baseRevisionId, canonical, source, assets = [] }) {
    const owner = requiredString(ownerScope, "ownerScope");
    const entity = requiredString(entityId, "entityId");
    const base = requiredString(baseRevisionId, "baseRevisionId");
    const assetRefs = this.assetLifecycle.prepare(assets);
    const prepared = prepareRevision(canonical, source, "edited", assetRefs);
    const revisionId = crypto.randomUUID();
    const createdAt = Date.now();
    const initial = this._revisionState(owner, entity, base, prepared.revisionHash);
    if (initial.duplicate) {
      return this.db.transaction(() => {
        const state = this._revisionState(owner, entity, base, prepared.revisionHash);
        return this._useDuplicate(state, entity, owner, prepared, createdAt);
      })();
    }
    return this.assetLifecycle.writeForMutation(assetRefs, () => (
      this.db.transaction(() => {
        const state = this._revisionState(owner, entity, base, prepared.revisionHash);
        if (state.duplicate) {
          return this._useDuplicate(state, entity, owner, prepared, createdAt);
        }
        const nextNumber = this.db.get(
          `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
           FROM character_revisions WHERE entity_id = ? AND owner_scope = ?`,
          entity, owner,
        ).next;
        // Edits keep the imported embedded book association (§7.2): the pin
        // propagates from the parent revision to revision N+1.
        const parentPin = this.db.get(
          `SELECT character_book_revision_id AS pin
           FROM character_revisions WHERE id = ? AND owner_scope = ?`,
          base, owner,
        )?.pin || null;
        this._insertRevision({
          id: revisionId, entityId: entity, owner,
          parentId: state.current.current_revision_id,
          number: nextNumber, prepared, createdAt,
          characterBookRevisionId: parentPin,
        });
        this._linkRevisionAssets(revisionId, owner, assetRefs, createdAt);
        this._updateCurrent(entity, owner, revisionId, prepared.displayName, createdAt);
        return this.getRevision(owner, revisionId);
      })()
    ));
  }
  listCharacters(ownerScope, { includeArchived = false } = {}) {
    const owner = requiredString(ownerScope, "ownerScope");
    const rows = includeArchived
      ? this.db.all(
          `SELECT * FROM character_entities
           WHERE owner_scope = ? ORDER BY updated_at DESC, id ASC`,
          owner,
        )
      : this.db.all(
          `SELECT * FROM character_entities
           WHERE owner_scope = ? AND archived_at IS NULL
           ORDER BY updated_at DESC, id ASC`,
          owner,
        );
    return rows.map(entityFromRow);
  }
  getCharacter(ownerScope, entityId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(entityId, "entityId");
    return entityFromRow(this.db.get(
      "SELECT * FROM character_entities WHERE id = ? AND owner_scope = ?",
      id, owner,
    ));
  }
  getRevision(ownerScope, revisionId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(revisionId, "revisionId");
    return this._revisionFromRow(this.db.get(
      "SELECT * FROM character_revisions WHERE id = ? AND owner_scope = ?",
      id, owner,
    ));
  }
  archiveCharacter(ownerScope, entityId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(entityId, "entityId");
    return this.db.transaction(() => {
      const row = this.db.get(
        "SELECT * FROM character_entities WHERE id = ? AND owner_scope = ?",
        id, owner,
      );
      if (!row) return null;
      const now = Date.now();
      this.db.run(
        `UPDATE character_entities
         SET archived_at = COALESCE(archived_at, ?), updated_at = ?
         WHERE id = ? AND owner_scope = ?`,
        now, now, id, owner,
      );
      return this.getCharacter(owner, id);
    })();
  }
  getBinding(sessionId, ownerScope) {
    const session = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    const row = this.db.get(
      `SELECT * FROM character_session_bindings
       WHERE session_id = ? AND owner_scope = ?`,
      session, owner,
    );
    return bindingFromRow(row, session);
  }
  /** §10.4.1 multi-book bindings: pinned world books per (session, scope). */
  getBookBindings(sessionId, ownerScope) {
    const session = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    return this.db.all(
      `SELECT scope, world_book_revision_id, merge_strategy, created_at
       FROM character_session_book_bindings
       WHERE session_id = ? AND owner_scope = ?
       ORDER BY rowid ASC`,
      session, owner,
    ).map((row) => ({
      scope: row.scope,
      worldBookRevisionId: row.world_book_revision_id,
      mergeStrategy: row.merge_strategy || "constant",
    }));
  }
  getConversationConfig(sessionId, ownerScope) {
    return getConversationConfig(this, sessionId, ownerScope);
  }
  setConversationConfig(input) {
    return setConversationConfig(this, input);
  }
  setBookBindings({ sessionId, ownerScope, books = [] }) {
    const session = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    const scopes = new Set();
    for (const book of books) {
      const scope = requiredString(book.scope, "book.scope");
      const revisionId = requiredString(book.worldBookRevisionId, "book.worldBookRevisionId");
      if (!["chat", "persona", "character", "global"].includes(scope)) {
        throw codedError("WORLD_BOOK_BINDING_INVALID", `Unsupported book scope ${scope}`);
      }
      if (scopes.has(scope)) throw codedError("WORLD_BOOK_BINDING_INVALID", `Duplicate book scope ${scope}`);
      scopes.add(scope);
    }
    return this.db.transaction(() => {
      this.db.run(
        "DELETE FROM character_session_book_bindings WHERE session_id = ? AND owner_scope = ?",
        session, owner,
      );
      for (const book of books) {
        this.db.run(
          `INSERT INTO character_session_book_bindings
             (session_id, owner_scope, scope, world_book_revision_id, merge_strategy, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          session, owner, book.scope, book.worldBookRevisionId,
          book.mergeStrategy || "constant", new Date().toISOString(),
        );
      }
    });
  }
  setBinding({ sessionId, ownerScope, expectedBindingVersion, next = {} }) {
    const session = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    const mode = next.mode || "native";
    if (mode !== "native" && mode !== "character") {
      throw codedError("CHARACTER_BINDING_INVALID", "Unsupported Phase 1 binding mode");
    }
    const committed = setConversationConfig(this, {
      sessionId: session,
      ownerScope: owner,
      expectedBindingVersion,
      compatibilityProfile: next.compatibilityProfile,
      next: {
        characterRevisionId: mode === "character"
          ? requiredString(next.characterRevisionId, "next.characterRevisionId")
          : null,
        personaRevisionId: mode === "character" && next.personaRevisionId != null
          ? requiredString(next.personaRevisionId, "next.personaRevisionId")
          : null,
        books: this.getBookBindings(session, owner),
        greetingIndex: mode === "character" ? next.greetingIndex : null,
      },
    });
    const { books, sceneId, groupId, ...legacyBinding } = committed;
    return legacyBinding;
  }
  getBindingEvents(sessionId, ownerScope, { afterVersion = 0, limit = 200 } = {}) {
    const session = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 200, 200));
    return this.db.all(
      `SELECT binding_version, event_json
       FROM character_binding_events
       WHERE session_id = ? AND owner_scope = ? AND binding_version > ?
       ORDER BY binding_version ASC LIMIT ?`,
      session, owner, Math.max(0, Number(afterVersion) || 0), boundedLimit,
    ).map((row) => ({
      ...JSON.parse(row.event_json),
      bindingVersion: row.binding_version,
    }));
  }
  reconcileOrphanBlobs(options) {
    return this.assetLifecycle.reconcile(options);
  }
}
module.exports = { CharacterWorldsRepository };
