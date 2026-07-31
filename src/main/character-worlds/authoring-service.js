"use strict";

/**
 * Validated authoring domain API (Phase 2B, Task P2B-3; spec §8/§13.2/§18).
 * ONE validated entry point for character/persona/world-book mutations, shared
 * by the library editor (IPC, P2B-4) now and the agent draft path later.
 *
 * - Validation reuses the SAME models as import: characters normalize through
 *   validation.js (the card-parser primitives) so hostile input fails with
 *   the identical CARD_* codes; personas/world books normalize inside their
 *   repositories (persona-model.js/world-book-model.js codes), unchanged.
 * - Owner scope is re-resolved per call and the caller's claim must match it;
 *   missing/empty ids fail coded (never TypeError); all failures are coded
 *   throws (the import-repository convention).
 * - Edits create a new immutable revision (CAS on expectedBaseRevisionId);
 *   bound conversations stay pinned to their admitted snapshot (§8). This
 *   service never writes bindings or turn metadata.
 * - Delete follows §18: while a CURRENT binding, admitted turn snapshot,
 *   character book pin, or world-book checkpoint references a revision,
 *   delete fails coded CHARACTER_ENTITY_IN_USE (character_binding_events is
 *   append-only audit history, deliberately not probed). Otherwise delete =
 *   archive: revisions are immutable rows, export leases are in-memory only,
 *   so physical GC is a later concern reported as hardDelete: "deferred_gc".
 */

const util = require("node:util");
const C = require("./constants");
const { executableKey } = require("./executable-keys");
const { codedError } = require("./persistence-codec");
const {
  assertPlainData,
  cardError,
  normalizeString,
  normalizeStringArray,
} = require("./validation");

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;
const MAX_FIELD_CHARS = C.DEFAULT_IMPORT_LIMITS.maxCanonicalFieldChars;

const CHARACTER_STRING_FIELDS = [
  "name", "description", "personality", "scenario", "firstMessage",
  "exampleDialogue", "creatorNotes", "systemPrompt",
  "postHistoryInstructions", "creator", "characterVersion",
];
const CHARACTER_ARRAY_FIELDS = ["alternateGreetings", "tags"];
const CHARACTER_KNOWN_KEYS = new Set([
  "schemaVersion",
  ...CHARACTER_STRING_FIELDS,
  ...CHARACTER_ARRAY_FIELDS,
]);

// Character canonical normalization through the same bounded primitives the
// import parser uses (validation.js), so hostile authoring input fails with
// the import model's exact codes. Unlike import — which maps an external card
// format — authoring input IS canonical, so a wrong-typed known field is a
// caller bug and fails coded instead of being defaulted. Unknown top-level
// fields are preserved inert (persona/world-book parity) EXCEPT
// executable-flagged keys (executable-keys.js), which are dropped from the
// stored canonical exactly as import refuses to normalize them; each dropped
// key is pushed to the optional `dropped` out array (bounded by the walk).
function normalizeCharacterCanonical(input, dropped) {
  if (util.types.isProxy(input)) {
    throw cardError("CARD_JSON_INVALID", "Character canonical data must not be a Proxy", {
      path: "",
    });
  }
  const data = assertPlainData(input);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw cardError("CARD_ROOT_INVALID", "Character canonical data must be a plain object", {
      path: "",
    });
  }
  const canonical = { schemaVersion: C.CHARACTER_SCHEMA_VERSION };
  for (const field of CHARACTER_STRING_FIELDS) {
    const value = data[field];
    if (value == null) {
      canonical[field] = "";
      continue;
    }
    if (typeof value !== "string") {
      throw cardError("CARD_JSON_INVALID", `Character field ${field} must be a string`, {
        path: `/${field}`,
      });
    }
    const normalized = normalizeString(value, MAX_FIELD_CHARS, `/${field}`);
    canonical[field] = field === "name" ? normalized.trim() : normalized;
  }
  if (!canonical.name) {
    throw cardError("CARD_ROOT_INVALID", "Character card name must be a non-empty string", {
      path: "/name",
    });
  }
  for (const field of CHARACTER_ARRAY_FIELDS) {
    const value = data[field];
    if (value == null) {
      canonical[field] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      throw cardError("CARD_JSON_INVALID", `Character field ${field} must be an array`, {
        path: `/${field}`,
      });
    }
    canonical[field] = normalizeStringArray(value, {}, field);
  }
  for (const key of Object.keys(data)) {
    if (CHARACTER_KNOWN_KEYS.has(key)) continue;
    if (executableKey(key)) {
      if (Array.isArray(dropped)) dropped.push(key);
      continue;
    }
    canonical[key] = data[key];
  }
  return canonical;
}

function validOwner(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}

// Ids are validated at the service boundary so empty/missing values fail
// coded instead of surfacing the repository's TypeError (requiredString).
function requireId(value, code, label) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw codedError(code, `${label} is required`);
  return id;
}

function withDrops(result, droppedExecutableKeys) {
  return droppedExecutableKeys.length ? { ...result, droppedExecutableKeys } : result;
}

const columnProbe = (name, table, column) => ({
  name,
  query: `SELECT 1 AS present FROM ${table} WHERE owner_scope = ? AND ${column} = ? LIMIT 1`,
  param: (revisionId) => revisionId,
});
const likeProbe = (name, table, column) => ({
  name,
  query: `SELECT 1 AS present FROM ${table} WHERE owner_scope = ? AND ${column} LIKE ? LIMIT 1`,
  param: (revisionId) => `%${revisionId}%`,
});
// LIKE probes on the immutable revision id are deliberately conservative
// (§18): a false positive only ever keeps data.
const TURN_SNAPSHOT_PROBE = likeProbe("turn_snapshot", "turn_inputs", "metadata_json");
const SCENE_CHECKPOINT_PROBE = likeProbe(
  "scene_checkpoint", "character_scene_checkpoints", "checkpoint_json",
);

const KINDS = {
  character: {
    table: "character_revisions",
    notFoundCode: "CHARACTER_NOT_FOUND",
    revisionNotFoundCode: "CHARACTER_REVISION_NOT_FOUND",
    conflictCode: "CHARACTER_REVISION_CONFLICT",
    create: (repository, input) => repository.createCharacter(input),
    createRevision: (repository, input) => repository.createRevision(input),
    getEntity: (repository, owner, id) => repository.getCharacter(owner, id),
    getRevision: (repository, owner, id) => repository.getRevision(owner, id),
    entityIdOf: (revision) => revision.characterId,
    assetsKey: "cardAssets",
    normalize: normalizeCharacterCanonical,
    references: [
      columnProbe("session_binding", "character_session_bindings", "character_revision_id"),
      TURN_SNAPSHOT_PROBE,
      SCENE_CHECKPOINT_PROBE,
    ],
  },
  persona: {
    table: "persona_revisions",
    notFoundCode: "PERSONA_NOT_FOUND",
    revisionNotFoundCode: "PERSONA_REVISION_NOT_FOUND",
    conflictCode: "PERSONA_REVISION_CONFLICT",
    create: (repository, input) => repository.createPersona(input),
    createRevision: (repository, input) => repository.createPersonaRevision(input),
    getEntity: (repository, owner, id) => repository.getPersona(owner, id),
    getRevision: (repository, owner, id) => repository.getPersonaRevision(owner, id),
    entityIdOf: (revision) => revision.personaId,
    assetsKey: "personaAssets",
    normalize: null, // persona-model normalizes inside the repository
    references: [
      columnProbe("session_binding", "character_session_bindings", "persona_revision_id"),
      TURN_SNAPSHOT_PROBE,
      SCENE_CHECKPOINT_PROBE,
    ],
  },
  worldBook: {
    table: "world_book_revisions",
    notFoundCode: "WORLD_BOOK_NOT_FOUND",
    revisionNotFoundCode: "WORLD_BOOK_REVISION_NOT_FOUND",
    conflictCode: "WORLD_BOOK_REVISION_CONFLICT",
    create: (repository, input) => repository.createWorldBook(input),
    createRevision: (repository, input) => repository.createWorldBookRevision(input),
    getEntity: (repository, owner, id) => repository.getWorldBook(owner, id),
    getRevision: (repository, owner, id) => repository.getWorldBookRevision(owner, id),
    entityIdOf: (revision) => revision.worldBookId,
    assetsKey: "bookAssets",
    normalize: null, // world-book-model normalizes inside the repository
    references: [
      columnProbe("character_pin", "character_revisions", "character_book_revision_id"),
      // The live per-session checkpoint table written on every successful
      // world-book turn gets a direct column probe.
      columnProbe("world_book_checkpoint", "world_book_checkpoints", "world_book_revision_id"),
      // A revision can also ride inside a serialized binding envelope
      // (worldBookBindings) — the id probe covers present and future.
      likeProbe("session_binding", "character_session_bindings", "binding_json"),
      TURN_SNAPSHOT_PROBE,
    ],
  },
};

class CharacterAuthoringService {
  constructor({ repository, resolveOwnerScope } = {}) {
    if (
      !repository?.createCharacter
      || !repository?.createRevision
      || !repository?.getRevision
      || !repository?.createPersona
      || !repository?.createWorldBook
      || !repository?.db
      || !repository?.blobs
    ) {
      throw new TypeError("CharacterAuthoringService requires CharacterWorldsRepository");
    }
    if (typeof resolveOwnerScope !== "function") {
      throw new TypeError("CharacterAuthoringService requires resolveOwnerScope");
    }
    this.repository = repository;
    this.resolveOwnerScope = resolveOwnerScope;
  }

  // Same owner discipline as CharacterWorldsService._owner: the scope is
  // always re-resolved in this process and the caller's claim must match it.
  async _owner(callerOwner) {
    let owner;
    try {
      owner = await this.resolveOwnerScope();
    } catch { /* falls through to the coded check below */ }
    if (!validOwner(owner)) {
      throw codedError("IMPORT_OWNER_UNAVAILABLE", "Current owner scope is unavailable");
    }
    if (callerOwner !== owner) {
      throw codedError("IMPORT_OWNER_MISMATCH", "Owner scope changed");
    }
    return owner;
  }

  _entity(kind, owner, entityId) {
    const id = requireId(entityId, KINDS[kind].notFoundCode, "entityId");
    const entity = KINDS[kind].getEntity(this.repository, owner, id);
    if (!entity) throw codedError(KINDS[kind].notFoundCode, `${kind} not found`);
    return entity;
  }

  _baseRevisionId(kind, value) {
    return requireId(value, KINDS[kind].conflictCode, "expectedBaseRevisionId");
  }

  // Rehydrate a stored revision's linked assets from the blob store so they
  // can ride onto a new revision; bytes are verified against the descriptor.
  _revisionAssets(revision, assetsKey) {
    const assets = [];
    for (const descriptor of revision[assetsKey] || []) {
      const data = this.repository.blobs.read(descriptor.hash);
      const intact = data
        && data.length === descriptor.bytes
        && this.repository.blobs.verify(descriptor.hash, descriptor.bytes);
      if (!intact) {
        throw codedError(
          "CHARACTER_ASSET_UNAVAILABLE",
          "Revision asset bytes are unavailable",
          { hash: descriptor.hash, purpose: descriptor.purpose },
        );
      }
      assets.push({ purpose: descriptor.purpose, mime: descriptor.mime, data });
    }
    return assets;
  }

  async _create(kind, { ownerScope, canonical, assets = [] } = {}) {
    const owner = await this._owner(ownerScope);
    const definition = KINDS[kind];
    const droppedExecutableKeys = [];
    const normalized = definition.normalize
      ? definition.normalize(canonical, droppedExecutableKeys)
      : canonical;
    const result = definition.create(this.repository, {
      ownerScope: owner,
      canonical: normalized,
      source: { kind: "created", format: "lily", container: "json" },
      assets,
    });
    return withDrops(
      { ok: true, entity: result.entity, revision: result.revision },
      droppedExecutableKeys,
    );
  }

  async _edit(kind, { ownerScope, entityId, expectedBaseRevisionId, canonical, assets = [] } = {}) {
    const owner = await this._owner(ownerScope);
    const definition = KINDS[kind];
    const id = requireId(entityId, definition.notFoundCode, "entityId");
    const base = this._baseRevisionId(kind, expectedBaseRevisionId);
    const droppedExecutableKeys = [];
    const normalized = definition.normalize
      ? definition.normalize(canonical, droppedExecutableKeys)
      : canonical;
    const revision = definition.createRevision(this.repository, {
      ownerScope: owner,
      entityId: id,
      baseRevisionId: base,
      canonical: normalized,
      source: { kind: "edited", format: "lily", container: "json" },
      assets,
    });
    return withDrops({ ok: true, revision }, droppedExecutableKeys);
  }

  async _history(kind, { ownerScope, entityId, limit } = {}) {
    const owner = await this._owner(ownerScope);
    const definition = KINDS[kind];
    const entity = this._entity(kind, owner, entityId);
    const bounded = Math.max(1, Math.min(
      Math.floor(Number(limit) || HISTORY_DEFAULT_LIMIT),
      HISTORY_MAX_LIMIT,
    ));
    // Metadata only: the canonical payload stays in the revision rows and is
    // loaded explicitly via get*Revision when a restore needs it.
    const revisions = this.repository.db.all(
      `SELECT id, revision_number, revision_hash, canonical_hash, source_kind,
              display_name, parent_revision_id, created_at
       FROM ${definition.table}
       WHERE owner_scope = ? AND entity_id = ?
       ORDER BY revision_number DESC, id ASC
       LIMIT ?`,
      owner, entity.id, bounded,
    ).map((row) => ({
      revisionId: row.id,
      revisionNumber: row.revision_number,
      revisionHash: row.revision_hash,
      contentHash: row.canonical_hash,
      sourceKind: row.source_kind,
      displayName: row.display_name,
      parentRevisionId: row.parent_revision_id || null,
      createdAt: new Date(Number(row.created_at)).toISOString(),
    }));
    return { ok: true, revisions };
  }

  async _restore(kind, { ownerScope, entityId, revisionId, expectedBaseRevisionId } = {}) {
    const owner = await this._owner(ownerScope);
    const definition = KINDS[kind];
    const entity = this._entity(kind, owner, entityId);
    const sourceId = requireId(revisionId, definition.revisionNotFoundCode, "revisionId");
    const base = this._baseRevisionId(kind, expectedBaseRevisionId);
    const source = definition.getRevision(this.repository, owner, sourceId);
    if (!source || definition.entityIdOf(source) !== entity.id) {
      throw codedError(definition.revisionNotFoundCode, `${kind} revision was not found`);
    }
    // The stored canonical was validated at admission, so it is copied
    // verbatim: the restored revision's canonical is byte-identical to
    // revision K's. Only the provenance envelope changes, which is exactly
    // what produces a new revision hash (dedup stays sound).
    const revision = definition.createRevision(this.repository, {
      ownerScope: owner,
      entityId: entity.id,
      baseRevisionId: base,
      canonical: structuredClone(source.canonical),
      source: {
        kind: "created",
        format: "lily",
        container: "json",
        restoredFromRevisionId: source.id,
      },
      assets: this._revisionAssets(source, definition.assetsKey),
    });
    return { ok: true, revision };
  }

  async _duplicate(kind, { ownerScope, entityId } = {}) {
    const owner = await this._owner(ownerScope);
    const definition = KINDS[kind];
    const entity = this._entity(kind, owner, entityId);
    const current = definition.getRevision(this.repository, owner, entity.currentRevisionId);
    if (!current) {
      throw codedError(definition.revisionNotFoundCode, `${kind} revision was not found`);
    }
    const input = {      ownerScope: owner,
      canonical: structuredClone(current.canonical),
      source: {
        kind: "created",
        format: "lily",
        container: "json",
        duplicatedFromEntityId: entity.id,
        duplicatedFromRevisionId: current.id,
      },
      assets: this._revisionAssets(current, definition.assetsKey),
    };
    // A duplicated character keeps the current revision's embedded world-book
    // pin (WB-2) while the pinned book revision is still readable.
    if (kind === "character" && current.characterBookRevisionId) {
      const pinned = this.repository.getWorldBookRevision(owner, current.characterBookRevisionId);
      if (pinned) input.characterBookRevisionId = current.characterBookRevisionId;
    }
    const result = definition.create(this.repository, input);
    return { ok: true, entity: result.entity, revision: result.revision };
  }

  async _archive(kind, { ownerScope, entityId } = {}) {
    const owner = await this._owner(ownerScope);
    const definition = KINDS[kind];
    const entity = this._entity(kind, owner, entityId);
    const archived = {
      character: () => this.repository.archiveCharacter(owner, entity.id),
      persona: () => this.repository.archivePersona(owner, entity.id),
      worldBook: () => this.repository.archiveWorldBook(owner, entity.id),
    }[kind]();
    return { ok: true, entity: archived };
  }

  // §18: no hard delete while a current binding, admitted turn snapshot,
  // character book pin, or world-book/scene checkpoint references a revision
  // of the entity. character_binding_events is append-only audit history and
  // deliberately not probed. (Export leases are in-memory destination
  // reservations released after each export; nothing persists there.)
  _collectReferences(kind, owner, entityId) {
    const definition = KINDS[kind];
    const revisionIds = this.repository.db.all(
      `SELECT id FROM ${definition.table} WHERE owner_scope = ? AND entity_id = ?`,
      owner, entityId,
    ).map((row) => row.id);
    const found = new Set();
    for (const revisionId of revisionIds) {
      for (const reference of definition.references) {
        if (found.has(reference.name)) continue;
        if (this.repository.db.get(reference.query, owner, reference.param(revisionId))) {
          found.add(reference.name);
        }
      }
    }
    return [...found].sort();
  }

  async _delete(kind, { ownerScope, entityId } = {}) {
    const owner = await this._owner(ownerScope);
    const entity = this._entity(kind, owner, entityId);
    const references = this._collectReferences(kind, owner, entity.id);
    if (references.length > 0) {
      throw codedError(
        "CHARACTER_ENTITY_IN_USE",
        `${kind} is still referenced and cannot be hard-deleted`,
        { references },
      );
    }
    // Unreferenced: delete = archive. Revision rows are immutable by trigger
    // and their blobs are refcounted; physical GC is a later concern (§18).
    // The probe-then-archive sequence is deliberately NOT transactional
    // (TOCTOU): a reference created in between is benign because delete only
    // ever archives — it never removes data — so it stays readable.
    const archived = await this._archive(kind, { ownerScope: owner, entityId: entity.id });
    return {
      ok: true,
      entityId: entity.id,
      archived: true,
      entity: archived.entity,
      hardDelete: "deferred_gc",
    };
  }

  createCharacter(input) { return this._create("character", input); }
  createPersona(input) { return this._create("persona", input); }
  createWorldBook(input) { return this._create("worldBook", input); }
  editCharacter(input) { return this._edit("character", input); }
  editPersona(input) { return this._edit("persona", input); }
  editWorldBook(input) { return this._edit("worldBook", input); }
  characterHistory(input) { return this._history("character", input); }
  personaHistory(input) { return this._history("persona", input); }
  worldBookHistory(input) { return this._history("worldBook", input); }
  restoreCharacterRevision(input) { return this._restore("character", input); }
  restorePersonaRevision(input) { return this._restore("persona", input); }
  restoreWorldBookRevision(input) { return this._restore("worldBook", input); }
  duplicateCharacter(input) { return this._duplicate("character", input); }
  duplicatePersona(input) { return this._duplicate("persona", input); }
  duplicateWorldBook(input) { return this._duplicate("worldBook", input); }
  archiveCharacter(input) { return this._archive("character", input); }
  archivePersona(input) { return this._archive("persona", input); }
  archiveWorldBook(input) { return this._archive("worldBook", input); }
  deleteCharacter(input) { return this._delete("character", input); }
  deletePersona(input) { return this._delete("persona", input); }
  deleteWorldBook(input) { return this._delete("worldBook", input); }
}

module.exports = {
  CharacterAuthoringService,
  normalizeCharacterCanonical,
};
