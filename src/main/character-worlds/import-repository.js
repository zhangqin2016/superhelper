"use strict";

const crypto = require("node:crypto");
const {
  codedError,
  prepareRevision,
  requiredString,
} = require("./persistence-codec");
const {
  importEmbeddedWorldBook,
} = require("./world-book-repository");

function duplicateRow(repository, owner, kind, hash) {
  if (!hash) return null;
  const predicate = kind === "exact"
    ? "r.original_hash = ?"
    : "r.canonical_hash = ?";
  return repository.db.get(
    `SELECT r.id AS revision_id, r.entity_id
     FROM character_revisions r
     JOIN character_entities e
       ON e.id = r.entity_id AND e.owner_scope = r.owner_scope
     WHERE r.owner_scope = ? AND ${predicate}
     ORDER BY (e.archived_at IS NOT NULL) ASC, r.created_at ASC, r.id ASC
     LIMIT 1`,
    owner, hash,
  );
}

function duplicateReference(row) {
  return row
    ? { entityId: row.entity_id, revisionId: row.revision_id }
    : null;
}

function isSqliteConstraint(error) {
  const numericCodes = [
    error?.errcode,
    error?.extendedCode,
    error?.extended_code,
  ].map(Number).filter(Number.isInteger);
  if (numericCodes.some((code) => (code & 0xff) === 19)) return true;
  return [
    "SQLITE_CONSTRAINT",
    "SQLITE_CONSTRAINT_PRIMARYKEY",
    "SQLITE_CONSTRAINT_UNIQUE",
    "ERR_SQLITE_CONSTRAINT",
  ].includes(error?.code);
}

function exactImportResult(repository, owner, row) {
  const entity = repository.getCharacter(owner, row.entity_id);
  const revision = entity
    ? repository.getRevision(owner, entity.currentRevisionId)
    : null;
  if (!entity || !revision) {
    throw codedError(
      "IMPORT_REPOSITORY_PROTOCOL",
      "Exact import duplicate has no current revision",
    );
  }
  return {
    entity,
    revision,
    matchedSourceRevisionId: row.revision_id,
    duplicate: {
      kind: "exact",
      reused: true,
      resolution: "reuse_existing",
    },
  };
}

function insertCharacter(repository, {
  owner,
  prepared,
  assetRefs,
  duplicateKind,
  characterBook,
}) {
  const entityId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const createdAt = Date.now();
  repository._insertRevision({
    id: revisionId, entityId, owner, parentId: null, number: 1, prepared, createdAt,
    characterBookRevisionId: characterBook ? characterBook.revisionId : null,
  });
  repository.db.run(
    `INSERT INTO character_entities
       (id, owner_scope, display_name, current_revision_id, archived_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    entityId, owner, prepared.displayName, revisionId, createdAt, createdAt,
  );
  repository._linkRevisionAssets(revisionId, owner, assetRefs, createdAt);
  return {
    entity: repository.getCharacter(owner, entityId),
    revision: repository.getRevision(owner, revisionId),
    characterBook,
    duplicate: {
      kind: duplicateKind,
      reused: false,
      resolution: duplicateKind === "canonical" ? "create_copy" : "created",
    },
  };
}

function findImportDuplicates(repository, ownerScope, {
  originalHash,
  canonicalHash,
} = {}) {
  const owner = requiredString(ownerScope, "ownerScope");
  const original = originalHash == null ? null : requiredString(originalHash, "originalHash");
  const canonical = canonicalHash == null
    ? null
    : requiredString(canonicalHash, "canonicalHash");
  if (original && !/^[a-f0-9]{64}$/.test(original)) {
    throw new TypeError("originalHash must be a SHA-256 digest");
  }
  if (canonical && !/^sha256:[a-f0-9]{64}$/.test(canonical)) {
    throw new TypeError("canonicalHash must be a SHA-256 content hash");
  }
  return {
    exact: duplicateReference(duplicateRow(repository, owner, "exact", original)),
    canonical: duplicateReference(
      duplicateRow(repository, owner, "canonical", canonical),
    ),
  };
}

function importCharacter(repository, {
  ownerScope,
  canonical,
  source,
  assets = [],
  characterBook = null,
  duplicateResolution,
  assertCanCommit,
}) {
  const owner = requiredString(ownerScope, "ownerScope");
  if (duplicateResolution != null && duplicateResolution !== "create_copy") {
    throw codedError(
      "IMPORT_DUPLICATE_RESOLUTION_INVALID",
      "Unsupported duplicate import resolution",
    );
  }
  if (assertCanCommit != null && typeof assertCanCommit !== "function") {
    throw new TypeError("assertCanCommit must be a function");
  }
  if (characterBook != null) {
    if (typeof characterBook !== "object" || characterBook.canonical == null) {
      throw codedError(
        "IMPORT_SOURCE_INVALID",
        "Imported embedded character book payload is invalid",
      );
    }
    if (characterBook.source != null && typeof characterBook.source !== "object") {
      throw codedError(
        "IMPORT_SOURCE_INVALID",
        "Imported embedded character book source is invalid",
      );
    }
  }
  const assetRefs = repository.assetLifecycle.prepare(assets);
  const prepared = prepareRevision(canonical, source, "created", assetRefs);
  if (!prepared.originalHash) {
    throw codedError(
      "IMPORT_SOURCE_INVALID",
      "Imported character source does not match its original asset",
    );
  }

  const mutation = () => repository.db.transaction(() => {
    const exact = duplicateRow(repository, owner, "exact", prepared.originalHash);
    if (exact) {
      assertCanCommit?.();
      repository._linkRevisionAssets(exact.revision_id, owner, assetRefs, Date.now());
      return exactImportResult(repository, owner, exact);
    }
    const canonicalDuplicate = duplicateRow(
      repository,
      owner,
      "canonical",
      prepared.canonicalHash,
    );
    if (canonicalDuplicate && duplicateResolution !== "create_copy") {
      throw codedError(
        "IMPORT_DUPLICATE_RESOLUTION_REQUIRED",
        "An equivalent character already exists",
        {
          existingEntityId: canonicalDuplicate.entity_id,
          existingRevisionId: canonicalDuplicate.revision_id,
        },
      );
    }
    assertCanCommit?.();
    // The embedded book revision is written in the same transaction as the
    // character revision that pins it: a rollback removes both, and an
    // identical book (same canonical + source, i.e. same revision hash) is
    // deduped to the existing book revision.
    const book = characterBook
      ? importEmbeddedWorldBook(repository, {
          ownerScope: owner,
          canonical: characterBook.canonical,
          source: characterBook.source || {
            kind: "imported",
            format: prepared.sourceValue.format,
            container: prepared.sourceValue.container,
            embedding: "character_book",
          },
        })
      : null;
    return insertCharacter(repository, {
      owner,
      prepared,
      assetRefs,
      duplicateKind: canonicalDuplicate ? "canonical" : "none",
      characterBook: book,
    });
  })();

  try {
    return repository.assetLifecycle.writeForMutation(assetRefs, mutation);
  } catch (error) {
    if (isSqliteConstraint(error)) {
      const concurrent = duplicateRow(
        repository,
        owner,
        "exact",
        prepared.originalHash,
      );
      if (concurrent) return exactImportResult(repository, owner, concurrent);
    }
    throw error;
  }
}

module.exports = {
  findImportDuplicates,
  importCharacter,
};
