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
  };
}
function bindingFromRow(row, sessionId) {
  if (!row) return nativeBinding(sessionId);
  return {
    schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
    sessionId,
    mode: row.mode,
    bindingVersion: row.binding_version,
    characterRevisionId: row.character_revision_id || null,
    personaRevisionId: row.persona_revision_id || null,
    compatibilityProfile: row.compatibility_profile || null,
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
    activeGreetingIndex: null,
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
  createCharacter({ ownerScope, canonical, source, assets = [] }) {
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
  setBinding({ sessionId, ownerScope, expectedBindingVersion, next = {} }) {
    const session = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    if (!Number.isInteger(expectedBindingVersion) || expectedBindingVersion < 0)
      throw new TypeError("expectedBindingVersion must be a non-negative integer");
    const mode = next.mode || "native";
    if (mode !== "native" && mode !== "character")
      throw codedError("CHARACTER_BINDING_INVALID", "Unsupported Phase 1 binding mode");
    return this.db.transaction(() => {
      const row = this.db.get(
        "SELECT * FROM character_session_bindings WHERE session_id = ?", session,
      );
      if (row && row.owner_scope !== owner)
        throw codedError("CHARACTER_BINDING_OWNER_MISMATCH",
          "Session binding belongs to another owner scope");
      const current = bindingFromRow(row, session);
      if (current.bindingVersion !== expectedBindingVersion)
        throw codedError("CHARACTER_BINDING_CONFLICT", "Binding version is stale", { current });
      let characterRevisionId = null;
      let personaRevisionId = null;
      let compatibilityProfile = null;
      if (mode === "character") {
        characterRevisionId = requiredString(
          next.characterRevisionId, "next.characterRevisionId");
        const revision = this.db.get(
          "SELECT 1 FROM character_revisions WHERE id = ? AND owner_scope = ?",
          characterRevisionId, owner,
        );
        if (!revision)
          throw codedError("CHARACTER_REVISION_NOT_FOUND", "Character revision not found");
        if (next.personaRevisionId != null) {
          // Optional persona pin (§7.5): an owner-scoped immutable persona
          // revision, validated exactly like the character revision.
          personaRevisionId = requiredString(
            next.personaRevisionId, "next.personaRevisionId");
          const personaRevision = this.db.get(
            "SELECT 1 FROM persona_revisions WHERE id = ? AND owner_scope = ?",
            personaRevisionId, owner,
          );
          if (!personaRevision)
            throw codedError("PERSONA_REVISION_NOT_FOUND", "Persona revision not found");
        }
        compatibilityProfile = String(
          next.compatibilityProfile || C.CHARACTER_COMPATIBILITY_PROFILE);
      }
      const createdAt = Date.now();
      const updatedAt = isoTime(createdAt);
      const committed = {
        schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
        sessionId: session, mode,
        bindingVersion: current.bindingVersion + 1,
        characterRevisionId, personaRevisionId, compatibilityProfile,
      };
      const envelope = bindingEnvelope(committed, updatedAt);
      const envelopeJson = stableJson(envelope);
      if (Buffer.byteLength(envelopeJson, "utf8") > C.MAX_CHARACTER_BINDING_BYTES) {
        throw codedError("CHARACTER_BINDING_TOO_LARGE",
          `Binding exceeds ${C.MAX_CHARACTER_BINDING_BYTES} bytes`);
      }
      this.db.run(
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
        session, owner, committed.bindingVersion, mode, characterRevisionId,
        personaRevisionId, compatibilityProfile, envelopeJson, createdAt,
      );
      let previousEnvelope;
      try {
        previousEnvelope = row ? JSON.parse(row.binding_json) : bindingEnvelope(current, null);
      } catch {
        previousEnvelope = bindingEnvelope(current, row ? isoTime(row.updated_at) : null);
      }
      const eventId = crypto.randomUUID();
      const event = {
        schemaVersion: C.CHARACTER_BINDING_SCHEMA_VERSION,
        id: eventId, sessionId: session,
        type: "character_binding.changed",
        previousBinding: previousEnvelope, nextBinding: envelope,
        effectiveAfterTurnId: null,
        createdAt: updatedAt,
      };
      this.db.run(
        `INSERT INTO character_binding_events
           (id, session_id, owner_scope, binding_version, event_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        eventId, session, owner, committed.bindingVersion,
        stableJson(event), createdAt,
      );
      return committed;
    })();
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
