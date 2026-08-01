"use strict";

/**
 * Character Worlds workspace portability (Phase 2C, Task P2C-2; design spec
 * §14.4 portability, §15 hostile import).
 *
 * Export side: from a project's sessions we collect ONLY the Character Worlds
 * entities referenced by current bindings + admitted turn snapshots and emit a
 * bounded `character-worlds.json` pack section (canonical revisions + asset
 * blob data + embedded world books). Nothing else ever leaves the machine: no
 * account data, credentials, absolute paths, runtime events, unrelated library
 * entries, or session ids.
 *
 * Import side: every entity gets NEW local ids (uuid regenerated through the
 * existing validated repository writers, so the exact same hostile pipeline
 * applies); character→book pins are remapped; bindings restore ONLY when their
 * referenced revisions imported, otherwise the conversation stays native with
 * a `missing_revision` diagnostic; exact-duplicate re-imports dedupe.
 *
 * The section format is deliberately small and schema-versioned:
 *   { schemaVersion: 1,
 *     entities: [{ kind: "character"|"persona", sourceEntityId, sourceRevisionId,
 *                  displayName, canonical, source, assets[], characterBook?, }],
 *     bindings: [{ mode, characterRevisionId, personaRevisionId }] }  // anonymous
 */

const MAX_PACK_ENTITIES = 64;
const MAX_PACK_JSON_BYTES = 4 * 1024 * 1024;
const PACK_SCHEMA_VERSION = 1;
const PACK_CHARACTER_WORLDS_ENTRY = ".lilyspace/character-worlds.json";

const crypto = require("node:crypto");
const { packJson } = require("./persistence-codec");
const { MAX_CHARACTER_CANONICAL_BYTES } = require("./constants");

/** Write the packed section into a workspace-pack zip (no-op when empty). */
function writePackEntry(zip, json) {
  if (String(json || "").trim()) zip.file(PACK_CHARACTER_WORLDS_ENTRY, json);
}

/** Read the packed section from a workspace-pack zip ("" when absent). */
async function readPackEntry(zip) {
  const entry = zip.file(PACK_CHARACTER_WORLDS_ENTRY);
  return entry ? await entry.async("string") : "";
}

function base64Of(value) {
  if (value == null) return "";
  return Buffer.from(value).toString("base64");
}

function bytesOf(value) {
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(value);
}

function assetsToPack(cardAssets) {
  return (Array.isArray(cardAssets) ? cardAssets : []).map((asset) => ({
    hash: asset.hash || "",
    mime: asset.mime || "",
    purpose: asset.purpose || "",
    data: base64Of(asset.bytes),
  }));
}

function assetsFromPack(assets) {
  return (Array.isArray(assets) ? assets : []).map((asset) => ({
    data: bytesOf(asset.data),
    mime: asset.mime || "",
    purpose: asset.purpose || "",
  }));
}

/** Deterministic canonical hash, byte-identical to the persistence layer's
 *  `sha256:<sha256(stableJson)>` so duplicate detection matches the DB. */
function canonicalHashOf(canonical) {
  const { json } = packJson(canonical, MAX_CHARACTER_CANONICAL_BYTES, "canonical");
  return `sha256:${crypto.createHash("sha256").update(json).digest("hex")}`;
}

/** Find an existing non-archived revision whose canonical matches, per kind. */
function findCanonicalRevision(repo, kind, ownerScope, canonical) {
  const hash = canonicalHashOf(canonical);
  const table = kind === "persona"
    ? { revisions: "persona_revisions", entities: "persona_entities" }
    : { revisions: "character_revisions", entities: "character_entities" };
  return repo.db.get(
    `SELECT r.id AS revision_id, r.entity_id
     FROM ${table.revisions} r
     JOIN ${table.entities} e
       ON e.id = r.entity_id AND e.owner_scope = r.owner_scope
     WHERE r.owner_scope = ? AND r.canonical_hash = ?
     ORDER BY (e.archived_at IS NOT NULL) ASC, r.created_at ASC, r.id ASC
     LIMIT 1`,
    ownerScope, hash,
  ) || null;
}

/** Import an embedded world book only when the destination has no identical
 *  revision (same normalized canonical + same source envelope → same hash);
 *  otherwise reuse the existing book revision (pin remap lands there). */
function importEmbeddedBookIfAbsent(repo, ownerScope, book) {
  const hash = canonicalHashOf(book.canonical);
  const existing = repo.db.get(
    `SELECT r.id AS revision_id, r.entity_id
     FROM world_book_revisions r
     JOIN world_book_entities e
       ON e.id = r.entity_id AND e.owner_scope = r.owner_scope
     WHERE r.owner_scope = ? AND r.canonical_hash = ?
     ORDER BY (e.archived_at IS NOT NULL) ASC, r.created_at ASC, r.id ASC
     LIMIT 1`,
    ownerScope, hash,
  );
  if (existing) return { revisionId: existing.revision_id, entityId: existing.entity_id, reused: true };
  const created = repo.createWorldBook({
    ownerScope,
    canonical: book.canonical,
    source: book.source,
    assets: assetsFromPack(book.assets),
  });
  return { revisionId: created.revision.id, entityId: created.entity.id, reused: false };
}

/**
 * Collect the Character Worlds entities referenced by the given sessions.
 * @param {object} repo CharacterWorldsRepository
 * @param {Array<{sessionId:string, ownerScope:string, snapshot?:object}>} sessions
 * @returns {{ entities: Array, bindings: Array }}
 */
function collectCharacterWorldsForExport(repo, sessions) {
  const entities = [];
  const bindings = [];
  const seen = new Set();

  const pushCharacter = (ownerScope, revisionId) => {
    if (!revisionId || seen.has(`character:${revisionId}`)) return;
    const rev = repo.getRevision(ownerScope, revisionId);
    if (!rev) return;
    seen.add(`character:${revisionId}`);
    const entity = {
      kind: "character",
      sourceEntityId: rev.characterId,
      sourceRevisionId: rev.id,
      displayName: rev.displayName,
      canonical: rev.canonical,
      source: rev.source,
      assets: assetsToPack(rev.cardAssets),
    };
    // A pinned world book travels INSIDE the character (embedded book) so the
    // pin is atomically remapped on import; identical books dedupe there.
    if (rev.characterBookRevisionId) {
      const bookRev = repo.getWorldBookRevision(ownerScope, rev.characterBookRevisionId);
      if (bookRev) {
        entity.characterBook = {
          displayName: bookRev.displayName,
          canonical: bookRev.canonical,
          source: bookRev.source,
          assets: assetsToPack(bookRev.cardAssets),
        };
      }
    }
    entities.push(entity);
  };

  const pushPersona = (ownerScope, revisionId) => {
    if (!revisionId || seen.has(`persona:${revisionId}`)) return;
    const rev = repo.getPersonaRevision(ownerScope, revisionId);
    if (!rev) return;
    seen.add(`persona:${revisionId}`);
    entities.push({
      kind: "persona",
      sourceEntityId: rev.personaId || rev.id,
      sourceRevisionId: rev.id,
      displayName: rev.name,
      canonical: rev.canonical,
      source: rev.source,
      assets: assetsToPack(rev.personaAssets),
    });
  };

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const ownerScope = session?.ownerScope;
    if (!ownerScope || !session?.sessionId) continue;
    let binding = null;
    try {
      binding = repo.getBinding(session.sessionId, ownerScope);
    } catch {
      binding = null;
    }
    if (binding && binding.mode === "character") {
      bindings.push({
        sessionId: binding.sessionId,
        mode: "character",
        characterRevisionId: binding.characterRevisionId || null,
        personaRevisionId: binding.personaRevisionId || null,
      });
      if (binding.characterRevisionId) {
        pushCharacter(ownerScope, binding.characterRevisionId);
      }
      if (binding.personaRevisionId) {
        pushPersona(ownerScope, binding.personaRevisionId);
      }
    }
    // Admitted turn snapshots (message metadata) can reference revisions even
    // when the CURRENT binding changed afterwards — collect those too.
    const snapshot = session.snapshot;
    if (snapshot && snapshot.mode === "character") {
      if (snapshot.characterRevisionId) {
        pushCharacter(ownerScope, snapshot.characterRevisionId);
      }
      if (snapshot.personaRevisionId) {
        pushPersona(ownerScope, snapshot.personaRevisionId);
      }
    }
  }

  return { entities, bindings };
}

/**
 * Serialize a collected pack into a bounded JSON section. Session ids are
 * deliberately NOT included (packing must never leak session identity).
 * @param {{entities: Array, bindings: Array}} collected
 * @returns {{ json: string, bytes: number, maxBytes: number }}
 */
function packCharacterWorldsSection(collected) {
  const entities = (collected?.entities || []).map((entity) => {
    const { characterBook, ...rest } = entity;
    const clean = { ...rest };
    if (characterBook) clean.characterBook = characterBook;
    return clean;
  });
  const bindings = (collected?.bindings || []).map((b) => ({
    mode: b.mode || "character",
    characterRevisionId: b.characterRevisionId || null,
    personaRevisionId: b.personaRevisionId || null,
  }));
  if (entities.length > MAX_PACK_ENTITIES) {
    throw new Error("CHARACTER_WORLDS_PACK_TOO_MANY_ENTITIES");
  }
  const json = JSON.stringify({ schemaVersion: PACK_SCHEMA_VERSION, entities, bindings });
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_PACK_JSON_BYTES) {
    throw new Error("CHARACTER_WORLDS_PACK_TOO_LARGE");
  }
  return { json, bytes, maxBytes: MAX_PACK_JSON_BYTES };
}

/**
 * Parse + validate a pack section (hostile input).
 * @param {string} json
 * @returns {{ schemaVersion: number, entities: Array, bindings: Array }}
 */
function unpackCharacterWorldsSection(json) {
  let parsed;
  try {
    parsed = JSON.parse(String(json || ""));
  } catch {
    throw new Error("CHARACTER_WORLDS_SECTION_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CHARACTER_WORLDS_SECTION_INVALID");
  }
  if (parsed.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new Error("CHARACTER_WORLDS_SECTION_VERSION_UNSUPPORTED");
  }
  if (!Array.isArray(parsed.entities)) {
    throw new Error("CHARACTER_WORLDS_SECTION_INVALID");
  }
  if (parsed.entities.length > MAX_PACK_ENTITIES) {
    throw new Error("CHARACTER_WORLDS_PACK_TOO_MANY_ENTITIES");
  }
  return parsed;
}

/**
 * Transactionally import every entity with NEW local ids, remapping
 * character→book pins. A canonical duplicate is a successful dedup, never an
 * error. Returns an id map (source revision id → new revision id) for binding
 * restoration.
 * @param {object} repo CharacterWorldsRepository (destination)
 * @param {string} ownerScope
 * @param {{ entities: Array }} section
 * @returns {{ ok: boolean, imported: Array, idMap: Record<string,string>, errors: Array }}
 */
function importCharacterWorldsPack(repo, ownerScope, section) {
  const imported = [];
  const errors = [];
  const idMap = {};
  for (const entity of Array.isArray(section?.entities) ? section.entities : []) {
    try {
      if (entity.kind === "character") {
        const assets = assetsFromPack(entity.assets);
        // Portability packs library entities whose source is the editor
        // envelope, NOT an original card — the card-import path (which
        // requires a matching source.original asset) does not apply. Dedupe
        // by canonical hash instead: an identical canonical under the same
        // owner reuses the existing entity+revision (idempotent re-import).
        const existing = findCanonicalRevision(repo, "character", ownerScope, entity.canonical);
        let result;
        if (existing) {
          result = {
            entity: repo.getCharacter(ownerScope, existing.entity_id),
            revision: repo.getRevision(ownerScope, existing.revision_id),
            duplicate: { reused: true },
          };
        } else {
          const book = entity.characterBook
            ? importEmbeddedBookIfAbsent(repo, ownerScope, entity.characterBook)
            : null;
          result = repo.createCharacter({
            ownerScope,
            canonical: entity.canonical,
            source: entity.source,
            assets,
            characterBookRevisionId: book ? book.revisionId : null,
          });
        }
        if (result.revision && entity.sourceRevisionId) {
          idMap[entity.sourceRevisionId] = result.revision.id;
        }
        imported.push({
          kind: "character",
          sourceEntityId: entity.sourceEntityId,
          sourceRevisionId: entity.sourceRevisionId,
          newEntityId: result.entity?.id || null,
          newRevisionId: result.revision?.id || null,
          characterBookNewRevisionId: result.revision?.characterBookRevisionId || null,
          deduped: Boolean(result.duplicate?.reused),
        });
      } else if (entity.kind === "persona") {
        const existing = findCanonicalRevision(repo, "persona", ownerScope, entity.canonical);
        let result;
        if (existing) {
          result = {
            entity: repo.getPersona(ownerScope, existing.entity_id),
            revision: repo.getPersonaRevision(ownerScope, existing.revision_id),
            duplicate: { reused: true },
          };
        } else {
          result = repo.createPersona({
            ownerScope,
            canonical: entity.canonical,
            source: entity.source,
            assets: assetsFromPack(entity.assets),
          });
        }
        if (result.revision && entity.sourceRevisionId) {
          idMap[entity.sourceRevisionId] = result.revision.id;
        }
        imported.push({
          kind: "persona",
          sourceEntityId: entity.sourceEntityId,
          sourceRevisionId: entity.sourceRevisionId,
          newEntityId: result.entity?.id || null,
          newRevisionId: result.revision?.id || null,
          deduped: Boolean(result.duplicate?.reused),
        });
      } else {
        errors.push({ kind: entity.kind || "unknown", error: "UNSUPPORTED_KIND" });
      }
    } catch (error) {
      errors.push({
        kind: entity.kind,
        sourceRevisionId: entity.sourceRevisionId,
        error: error?.code || error?.message || "IMPORT_FAILED",
      });
    }
  }
  return { ok: errors.length === 0, imported, idMap, errors };
}

/**
 * Decide, per recorded binding, whether it can be restored after an import.
 * Only bindings whose referenced revisions were actually imported restore;
 * everything else stays native with a diagnostic. Session ids are preserved
 * when present (memory-side calls); packed anonymous bindings fall back to
 * `binding-<index>` labels.
 * @param {Record<string,string>} idMap source revision id → new revision id
 * @param {Array} bindings
 * @returns {Array<{sessionId:string, restored:boolean, newCharacterRevisionId?:string|null, newPersonaRevisionId?:string|null, diagnostic?:string}>}
 */
function restoreBindingPreview(idMap, bindings) {
  const map = idMap && typeof idMap === "object" ? idMap : {};
  return (Array.isArray(bindings) ? bindings : []).map((binding, index) => {
    const sessionId = typeof binding?.sessionId === "string" && binding.sessionId
      ? binding.sessionId
      : `binding-${index}`;
    const refs = [binding?.characterRevisionId, binding?.personaRevisionId].filter(Boolean);
    if (refs.length === 0) {
      return { sessionId, restored: false, diagnostic: "native" };
    }
    const missing = refs.filter((id) => !map[id]);
    if (missing.length > 0) {
      return { sessionId, restored: false, diagnostic: "missing_revision", missing };
    }
    return {
      sessionId,
      restored: true,
      newCharacterRevisionId: binding.characterRevisionId ? map[binding.characterRevisionId] : null,
      newPersonaRevisionId: binding.personaRevisionId ? map[binding.personaRevisionId] : null,
    };
  });
}

module.exports = {
  MAX_PACK_ENTITIES,
  MAX_PACK_JSON_BYTES,
  PACK_SCHEMA_VERSION,
  PACK_CHARACTER_WORLDS_ENTRY,
  collectCharacterWorldsForExport,
  packCharacterWorldsSection,
  readPackEntry,
  restoreBindingPreview,
  unpackCharacterWorldsSection,
  importCharacterWorldsPack,
  writePackEntry,
};
