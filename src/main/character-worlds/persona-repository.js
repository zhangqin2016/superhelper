"use strict";

/**
 * Persona persistence: entity pointers plus immutable, hash-deduped
 * revisions. Mirrors the world-book repository (and through it the character
 * revision discipline in repository.js) — same transaction shape, CAS on
 * baseRevisionId, duplicate-revision reuse via idx_persona_revision_hash,
 * owner-scoped reads, and blob refcounting through the shared
 * CharacterAssetLifecycle. The avatar is an ordinary linked asset with
 * purpose "avatar"; revisionFromRow surfaces its hash as avatarAssetId
 * (§7.3). Personas are narrative-only: no account/authorization state is
 * stored anywhere in these tables (see persona-model.js for the reject-loud
 * rule on auth-shaped canonical fields).
 */

const crypto = require("node:crypto");
const C = require("./constants");
const {
  codedError,
  isoTime,
  requiredString,
  unpackJson,
} = require("./persistence-codec");
const {
  normalizePersonaCanonical,
  preparePersonaRevision,
} = require("./persona-model");

function entityFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: C.PERSONA_SCHEMA_VERSION,
    id: row.id,
    ownerScope: row.owner_scope,
    displayName: row.display_name,
    currentRevisionId: row.current_revision_id,
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    archivedAt: isoTime(row.archived_at),
  };
}

function revisionFromRow(repository, row) {
  if (!row) return null;
  const personaAssets = repository.db.all(
    `SELECT hash, bytes, mime, purpose FROM persona_revision_blobs rb
     WHERE rb.revision_id = ? AND rb.owner_scope = ?
     ORDER BY rb.purpose ASC, rb.hash ASC`,
    row.id, row.owner_scope,
  ).map((asset) => ({
    hash: asset.hash, bytes: asset.bytes, mime: asset.mime, purpose: asset.purpose,
  }));
  const avatar = personaAssets.find((asset) => asset.purpose === "avatar");
  return {
    schemaVersion: C.PERSONA_SCHEMA_VERSION,
    id: row.id,
    personaId: row.entity_id,
    ownerScope: row.owner_scope,
    parentRevisionId: row.parent_revision_id || null,
    revisionNumber: row.revision_number,
    name: row.display_name,
    contentHash: row.canonical_hash,
    revisionHash: row.revision_hash,
    avatarAssetId: avatar ? avatar.hash : null,
    source: unpackJson(row.source_json),
    canonical: unpackJson(row.canonical_json),
    personaAssets,
    createdAt: isoTime(row.created_at),
  };
}

function linkRevisionAssets(repository, revisionId, owner, assets, createdAt) {
  for (const asset of assets) {
    repository.db.run(
      `INSERT OR IGNORE INTO blobs (hash, bytes, mime, refcount, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      asset.hash, asset.bytes, asset.mime, createdAt,
    );
    const linked = repository.db.run(
      `INSERT OR IGNORE INTO persona_revision_blobs
         (revision_id, owner_scope, hash, bytes, mime, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
      revisionId, owner, asset.hash, asset.bytes, asset.mime, asset.purpose,
    );
    if (linked.changes > 0) {
      repository.db.run("UPDATE blobs SET refcount = refcount + 1 WHERE hash = ?", asset.hash);
    }
  }
}

function insertRevision(repository, { id, entityId, owner, parentId, number, prepared, createdAt }) {
  repository.db.run(
    `INSERT INTO persona_revisions
       (id, entity_id, owner_scope, parent_revision_id, revision_number,
        display_name, source_kind, source_format, source_container,
        canonical_json, source_json, canonical_hash, original_hash,
        revision_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, entityId, owner, parentId, number,
    prepared.displayName, prepared.sourceValue.kind, prepared.sourceValue.format,
    prepared.sourceValue.container, prepared.canonicalData.packed,
    prepared.sourceData.packed, prepared.canonicalHash, prepared.originalHash,
    prepared.revisionHash, createdAt,
  );
}

function updateCurrent(repository, entityId, owner, revisionId, displayName, updatedAt) {
  repository.db.run(
    `UPDATE persona_entities
     SET display_name = ?, current_revision_id = ?, updated_at = ?
     WHERE id = ? AND owner_scope = ?`,
    displayName, revisionId, updatedAt, entityId, owner,
  );
}

function revisionState(repository, owner, entityId, baseRevisionId, revisionHash) {
  const current = repository.db.get(
    "SELECT * FROM persona_entities WHERE id = ? AND owner_scope = ?",
    entityId, owner,
  );
  if (!current) throw codedError("PERSONA_NOT_FOUND", "Persona not found");
  if (current.current_revision_id !== baseRevisionId) {
    throw codedError("PERSONA_REVISION_CONFLICT", "Persona revision is stale", {
      currentRevisionId: current.current_revision_id });
  }
  const duplicate = repository.db.get(
    `SELECT * FROM persona_revisions
     WHERE owner_scope = ? AND entity_id = ? AND revision_hash = ?`,
    owner, entityId, revisionHash,
  );
  return { current, duplicate };
}

function useDuplicate(repository, state, entityId, owner, prepared, updatedAt) {
  if (state.duplicate.id !== state.current.current_revision_id) {
    updateCurrent(repository, entityId, owner, state.duplicate.id,
      prepared.displayName, updatedAt);
  }
  return revisionFromRow(repository, state.duplicate);
}

function createPersona(repository, { ownerScope, canonical, source, assets = [] }) {
  const owner = requiredString(ownerScope, "ownerScope");
  const normalized = normalizePersonaCanonical(canonical);
  const assetRefs = repository.assetLifecycle.prepare(assets);
  const prepared = preparePersonaRevision(normalized, source, "created", assetRefs);
  const entityId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const createdAt = Date.now();
  return repository.assetLifecycle.writeForMutation(assetRefs, () => (
    repository.db.transaction(() => {
      insertRevision(repository, {
        id: revisionId, entityId, owner, parentId: null, number: 1, prepared, createdAt,
      });
      repository.db.run(
        `INSERT INTO persona_entities
           (id, owner_scope, display_name, current_revision_id, archived_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        entityId, owner, prepared.displayName, revisionId, createdAt, createdAt,
      );
      linkRevisionAssets(repository, revisionId, owner, assetRefs, createdAt);
      return {
        entity: getPersona(repository, owner, entityId),
        revision: getPersonaRevision(repository, owner, revisionId),
      };
    })()
  ));
}

function createPersonaRevision(repository, {
  ownerScope, entityId, baseRevisionId, canonical, source, assets = [],
}) {
  const owner = requiredString(ownerScope, "ownerScope");
  const entity = requiredString(entityId, "entityId");
  const base = requiredString(baseRevisionId, "baseRevisionId");
  const normalized = normalizePersonaCanonical(canonical);
  const assetRefs = repository.assetLifecycle.prepare(assets);
  const prepared = preparePersonaRevision(normalized, source, "edited", assetRefs);
  const revisionId = crypto.randomUUID();
  const createdAt = Date.now();
  const initial = revisionState(repository, owner, entity, base, prepared.revisionHash);
  if (initial.duplicate) {
    return repository.db.transaction(() => {
      const state = revisionState(repository, owner, entity, base, prepared.revisionHash);
      return useDuplicate(repository, state, entity, owner, prepared, createdAt);
    })();
  }
  return repository.assetLifecycle.writeForMutation(assetRefs, () => (
    repository.db.transaction(() => {
      const state = revisionState(repository, owner, entity, base, prepared.revisionHash);
      if (state.duplicate) {
        return useDuplicate(repository, state, entity, owner, prepared, createdAt);
      }
      const nextNumber = repository.db.get(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
         FROM persona_revisions WHERE entity_id = ? AND owner_scope = ?`,
        entity, owner,
      ).next;
      insertRevision(repository, {
        id: revisionId, entityId: entity, owner,
        parentId: state.current.current_revision_id,
        number: nextNumber, prepared, createdAt,
      });
      linkRevisionAssets(repository, revisionId, owner, assetRefs, createdAt);
      updateCurrent(repository, entity, owner, revisionId, prepared.displayName, createdAt);
      return getPersonaRevision(repository, owner, revisionId);
    })()
  ));
}

function listPersonas(repository, ownerScope, { includeArchived = false } = {}) {
  const owner = requiredString(ownerScope, "ownerScope");
  const rows = includeArchived
    ? repository.db.all(
        `SELECT * FROM persona_entities
         WHERE owner_scope = ? ORDER BY updated_at DESC, id ASC`,
        owner,
      )
    : repository.db.all(
        `SELECT * FROM persona_entities
         WHERE owner_scope = ? AND archived_at IS NULL
         ORDER BY updated_at DESC, id ASC`,
        owner,
      );
  return rows.map(entityFromRow);
}

function getPersona(repository, ownerScope, entityId) {
  const owner = requiredString(ownerScope, "ownerScope");
  const id = requiredString(entityId, "entityId");
  return entityFromRow(repository.db.get(
    "SELECT * FROM persona_entities WHERE id = ? AND owner_scope = ?",
    id, owner,
  ));
}

function getPersonaRevision(repository, ownerScope, revisionId) {
  const owner = requiredString(ownerScope, "ownerScope");
  const id = requiredString(revisionId, "revisionId");
  return revisionFromRow(repository, repository.db.get(
    "SELECT * FROM persona_revisions WHERE id = ? AND owner_scope = ?",
    id, owner,
  ));
}

function archivePersona(repository, ownerScope, entityId) {
  const owner = requiredString(ownerScope, "ownerScope");
  const id = requiredString(entityId, "entityId");
  return repository.db.transaction(() => {
    const row = repository.db.get(
      "SELECT * FROM persona_entities WHERE id = ? AND owner_scope = ?",
      id, owner,
    );
    if (!row) return null;
    const now = Date.now();
    repository.db.run(
      `UPDATE persona_entities
       SET archived_at = COALESCE(archived_at, ?), updated_at = ?
       WHERE id = ? AND owner_scope = ?`,
      now, now, id, owner,
    );
    return getPersona(repository, owner, id);
  })();
}

module.exports = {
  archivePersona,
  createPersona,
  createPersonaRevision,
  getPersona,
  getPersonaRevision,
  listPersonas,
};
