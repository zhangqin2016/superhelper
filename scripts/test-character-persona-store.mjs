// Character Worlds persona persistence contract (Phase 2B, Task P2B-1).
// Personas are narrative context only (spec §7.3/§19.2): authorization-shaped
// top-level fields are REJECTED, never silently stripped.
// Run: node scripts/test-character-persona-store.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");
const {
  MAX_PERSONA_CANONICAL_BYTES,
  MAX_PERSONA_DATA_ARRAY_LENGTH,
  MAX_PERSONA_DATA_DEPTH,
  MAX_PERSONA_DATA_NODES,
  MAX_PERSONA_DESCRIPTION_CHARS,
  MAX_PERSONA_LIMITS_VERSION,
  MAX_PERSONA_NAME_CHARS,
  MAX_PERSONA_STRING_CHARS,
  PERSONA_SCHEMA_VERSION,
} = require("../src/main/character-worlds/constants.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  normalizePersonaCanonical,
} = require("../src/main/character-worlds/persona-model.js");

const OWNER = "profile:local";
const OTHER_OWNER = "profile:local:child";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedHash(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function tableColumns(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
}

function assertPersonaLimit(fn, limitKind, limit) {
  assert.throws(fn, (error) => (
    error.code === "PERSONA_LIMIT_EXCEEDED"
    && error.limitsVersion === MAX_PERSONA_LIMITS_VERSION
    && error.limitKind === limitKind
    && error.limit === limit
    && Number.isFinite(error.actual)
  ));
}

const personaCanonical = {
  schemaVersion: 1,
  name: "Aurelia Persona",
  description: "A tide-locked cartographer who speaks in harbor metaphors.",
};
const personaSource = {
  kind: "created",
  format: "lily",
  container: "json",
  originalFileName: "persona-draft.json",
};
const EXPECTED_NORMALIZED_CANONICAL = {
  schemaVersion: PERSONA_SCHEMA_VERSION,
  name: "Aurelia Persona",
  description: "A tide-locked cartographer who speaks in harbor metaphors.",
};
const avatarBytes = Buffer.from("local-private-persona-avatar");
const avatarAsset = { purpose: "avatar", mime: "image/png", data: avatarBytes };
const avatarHash = crypto.createHash("sha256").update(avatarBytes).digest("hex");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-persona-store-"));
const freshDbPath = path.join(tmp, "fresh.db");
const freshBlobDir = path.join(tmp, "fresh-blobs");
const migratedDbPath = path.join(tmp, "migrated.db");
const migratedBlobDir = path.join(tmp, "migrated-blobs");

let freshStore;
let reopenedStore;
let migratedStore;

try {
  const v2 = openDatabase(migratedDbPath);
  v2.migrate(MIGRATIONS.slice(0, 2));
  v2.run("INSERT INTO schema_meta (key, value) VALUES (?, ?)", "v2-probe", "preserved");
  assert.equal(v2.pragma("user_version"), 2);
  v2.close();

  migratedStore = new MessageStore(migratedDbPath, migratedBlobDir);
  check("migrations v3-v15 upgrade a v2 database additively", () => {
    assert.equal(migratedStore.db.pragma("user_version"), MIGRATIONS.length);
    assert.equal(migratedStore.meta("v2-probe"), "preserved");
    const revisionColumns = tableColumns(migratedStore.db, "persona_revisions");
    for (const column of [
      "display_name", "source_kind", "source_format", "source_container",
      "source_json", "revision_hash", "original_hash",
    ]) {
      assert.ok(revisionColumns.includes(column), `missing persona_revisions.${column}`);
    }
    assert.ok(migratedStore.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'persona_revision_blobs'",
    ));
  });

  freshStore = new MessageStore(freshDbPath, freshBlobDir);

  const legacyDbPath = path.join(tmp, "legacy-v7.db");
  const legacyBlobDir = path.join(tmp, "legacy-v7-blobs");
  const legacyEntityId = crypto.randomUUID();
  const legacyRevisionIds = [crypto.randomUUID(), crypto.randomUUID()];
  const legacyV7 = openDatabase(legacyDbPath);
  legacyV7.migrate(MIGRATIONS.slice(0, 7));
  legacyV7.transaction(() => {
    legacyV7.run(
      `INSERT INTO persona_entities
         (id, owner_scope, display_name, current_revision_id, archived_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      legacyEntityId, OWNER, "Legacy Persona", legacyRevisionIds[0], 1000, 1000,
    );
    for (const [index, revisionId] of legacyRevisionIds.entries()) {
      legacyV7.run(
        `INSERT INTO persona_revisions
           (id, entity_id, owner_scope, parent_revision_id, revision_number,
            canonical_json, canonical_hash, created_at)
         VALUES (?, ?, ?, NULL, ?, '{}', ?, ?)`,
        revisionId, legacyEntityId, OWNER, index + 1,
        `sha256:${"0".repeat(63)}${index}`, 1000,
      );
    }
  })();
  legacyV7.close();

  const legacyStore = new MessageStore(legacyDbPath, legacyBlobDir);
  check("migration v11 backfills pre-existing rows before the dedup index", () => {
    assert.equal(legacyStore.db.pragma("user_version"), MIGRATIONS.length);
    const rows = legacyStore.db.all(
      `SELECT id, revision_hash FROM persona_revisions
       WHERE entity_id = ? ORDER BY revision_number ASC`,
      legacyEntityId,
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.revision_hash),
      legacyRevisionIds.map((id) => `legacy:${id}`),
    );
    assert.equal(new Set(rows.map((row) => row.revision_hash)).size, 2);
  });
  legacyStore.close();

  check("a v12 database opened by a v7 migration set is a designed no-op", () => {
    const pinDbPath = path.join(tmp, "forward-pin.db");
    const pinSeed = openDatabase(pinDbPath);
    pinSeed.migrate(MIGRATIONS);
    assert.equal(pinSeed.pragma("user_version"), MIGRATIONS.length);
    pinSeed.close();
    const pinDb = openDatabase(pinDbPath);
    assert.equal(pinDb.migrate(MIGRATIONS.slice(0, 7)), MIGRATIONS.length);
    assert.equal(pinDb.pragma("user_version"), MIGRATIONS.length);
    pinDb.close();
  });

  const repository = freshStore.characterWorlds();

  check("MessageStore exposes the shared Character Worlds repository", () => {
    assert.ok(repository instanceof CharacterWorldsRepository);
    assert.equal(freshStore.characterWorlds(), repository);
  });

  check("a fresh database contains the persona parity tables", () => {
    const tables = new Set(freshStore.db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name));
    for (const table of [
      "persona_entities",
      "persona_revisions",
      "persona_revision_blobs",
    ]) {
      assert.ok(tables.has(table), `missing ${table}`);
    }
  });

  check("persona tables carry the character revision discipline", () => {
    const entityColumns = tableColumns(freshStore.db, "persona_entities");
    for (const column of [
      "id", "owner_scope", "display_name", "current_revision_id",
      "archived_at", "created_at", "updated_at",
    ]) {
      assert.ok(entityColumns.includes(column), `missing persona_entities.${column}`);
    }
    const revisionColumns = tableColumns(freshStore.db, "persona_revisions");
    for (const column of [
      "id", "entity_id", "owner_scope", "parent_revision_id", "revision_number",
      "display_name", "source_kind", "source_format", "source_container",
      "canonical_json", "source_json", "canonical_hash", "original_hash",
      "revision_hash", "created_at",
    ]) {
      assert.ok(revisionColumns.includes(column), `missing persona_revisions.${column}`);
    }
    const blobColumns = tableColumns(freshStore.db, "persona_revision_blobs");
    for (const column of ["revision_id", "owner_scope", "hash", "bytes", "mime", "purpose"]) {
      assert.ok(blobColumns.includes(column), `missing persona_revision_blobs.${column}`);
    }
  });

  check("persona parity indexes exist", () => {
    const indexes = new Set(freshStore.db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).map((row) => row.name));
    for (const index of [
      "idx_persona_entities_owner",
      "idx_persona_revision_hash",
      "idx_persona_revisions_id_owner",
      "idx_persona_revision_content_hash",
      "idx_persona_revision_owner_original",
      "idx_persona_revision_owner_canonical",
    ]) {
      assert.ok(indexes.has(index), `missing ${index}`);
    }
  });

  const first = repository.createPersona({
    ownerScope: OWNER,
    canonical: personaCanonical,
    source: personaSource,
    assets: [avatarAsset],
  });

  check("persona creation atomically creates an immutable first revision", () => {
    assert.equal(first.entity.currentRevisionId, first.revision.id);
    assert.equal(first.entity.displayName, "Aurelia Persona");
    assert.equal(first.entity.ownerScope, OWNER);
    assert.equal(first.entity.archivedAt, null);
    assert.equal(first.revision.personaId, first.entity.id);
    assert.equal(first.revision.parentRevisionId, null);
    assert.equal(first.revision.revisionNumber, 1);
    assert.equal(first.revision.name, "Aurelia Persona");
    assert.equal(first.revision.avatarAssetId, avatarHash);
    assert.match(first.revision.revisionHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.revision.source, personaSource);
  });

  check("the canonical is normalized to the bounded §7.3 revision shape", () => {
    const stored = repository.getPersonaRevision(OWNER, first.revision.id);
    assert.deepEqual(stored.canonical, EXPECTED_NORMALIZED_CANONICAL);
    assert.equal(stored.contentHash, expectedHash(EXPECTED_NORMALIZED_CANONICAL));
    assert.equal(stored.schemaVersion, PERSONA_SCHEMA_VERSION);
  });

  check("avatar bytes are cataloged and linked to the persona revision", () => {
    assert.deepEqual(first.revision.personaAssets, [{
      hash: avatarHash,
      bytes: avatarBytes.length,
      mime: "image/png",
      purpose: "avatar",
    }]);
    assert.ok(freshStore.blobs.exists(avatarHash));
    assert.deepEqual(
      { ...freshStore.db.get("SELECT hash, bytes, mime, refcount FROM blobs WHERE hash = ?", avatarHash) },
      { hash: avatarHash, bytes: avatarBytes.length, mime: "image/png", refcount: 1 },
    );
    assert.deepEqual(
      { ...freshStore.db.get(
        `SELECT revision_id, owner_scope, hash, purpose
         FROM persona_revision_blobs WHERE revision_id = ?`,
        first.revision.id,
      ) },
      { revision_id: first.revision.id, owner_scope: OWNER, hash: avatarHash, purpose: "avatar" },
    );
  });

  check("identical revision envelopes dedupe to the existing revision id", () => {
    const reordered = {
      description: personaCanonical.description,
      name: personaCanonical.name,
      schemaVersion: 1,
    };
    const deduped = repository.createPersonaRevision({
      ownerScope: OWNER,
      entityId: first.entity.id,
      baseRevisionId: first.revision.id,
      canonical: reordered,
      source: { ...personaSource },
      assets: [{ ...avatarAsset }],
    });
    assert.equal(deduped.id, first.revision.id);
    assert.equal(deduped.revisionHash, first.revision.revisionHash);
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM persona_revisions WHERE entity_id = ?",
        first.entity.id,
      ).count,
      1,
    );
    assert.equal(repository.getPersona(OWNER, first.entity.id).currentRevisionId, first.revision.id);
  });

  const changedSource = { ...personaSource, originalFileName: "persona-copy.json" };
  const sourceRevision = repository.createPersonaRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: first.revision.id,
    canonical: { ...personaCanonical },
    source: changedSource,
    assets: [{ ...avatarAsset }],
  });

  check("revision hash covers provenance as well as canonical data", () => {
    assert.notEqual(sourceRevision.id, first.revision.id);
    assert.equal(sourceRevision.contentHash, first.revision.contentHash);
    assert.notEqual(sourceRevision.revisionHash, first.revision.revisionHash);
    assert.equal(sourceRevision.revisionNumber, 2);
    assert.equal(sourceRevision.parentRevisionId, first.revision.id);
    assert.deepEqual(sourceRevision.source, changedSource);
    assert.equal(repository.getPersona(OWNER, first.entity.id).currentRevisionId, sourceRevision.id);
  });

  const alternateAvatarBytes = Buffer.from("different-local-persona-avatar");
  const alternateAvatarHash = crypto.createHash("sha256").update(alternateAvatarBytes).digest("hex");
  const assetRevision = repository.createPersonaRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: sourceRevision.id,
    canonical: { ...personaCanonical },
    source: changedSource,
    assets: [{ purpose: "avatar", mime: "image/png", data: alternateAvatarBytes }],
  });

  check("revision hash covers linked assets and re-points avatarAssetId", () => {
    assert.notEqual(assetRevision.id, sourceRevision.id);
    assert.equal(assetRevision.contentHash, sourceRevision.contentHash);
    assert.notEqual(assetRevision.revisionHash, sourceRevision.revisionHash);
    assert.equal(assetRevision.revisionNumber, 3);
    assert.equal(assetRevision.avatarAssetId, alternateAvatarHash);
    assert.ok(freshStore.blobs.exists(alternateAvatarHash));
  });

  check("a stale base revision fails without replacing current", () => {
    assert.throws(
      () => repository.createPersonaRevision({
        ownerScope: OWNER,
        entityId: first.entity.id,
        baseRevisionId: first.revision.id,
        canonical: { schemaVersion: 1, name: "Stale edit" },
      }),
      (error) => error.code === "PERSONA_REVISION_CONFLICT"
        && error.currentRevisionId === assetRevision.id,
    );
    assert.equal(
      repository.getPersona(OWNER, first.entity.id).currentRevisionId,
      assetRevision.id,
    );
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM persona_revisions WHERE entity_id = ?",
        first.entity.id,
      ).count,
      3,
    );
  });

  check("revisions against a missing entity fail loud", () => {
    assert.throws(
      () => repository.createPersonaRevision({
        ownerScope: OWNER,
        entityId: crypto.randomUUID(),
        baseRevisionId: crypto.randomUUID(),
        canonical: { schemaVersion: 1, name: "Ghost" },
      }),
      (error) => error.code === "PERSONA_NOT_FOUND",
    );
  });

  check("unknown fields are preserved inert at the top level", () => {
    const hostile = repository.createPersona({
      ownerScope: OWNER,
      canonical: {
        schemaVersion: 1,
        name: "Future Persona",
        description: "kept",
        futurePersonaField: { nested: ["preserve", 1] },
      },
      source: { kind: "created", format: "lily", container: "json" },
    });
    const stored = repository.getPersonaRevision(OWNER, hostile.revision.id).canonical;
    assert.deepEqual(stored.futurePersonaField, { nested: ["preserve", 1] });
    assert.equal(stored.name, "Future Persona");
  });

  check("authorization-shaped top-level fields are rejected, never stripped", () => {
    for (const [key, value] of [
      ["accountId", "acct-123"],
      ["role", "admin"],
      ["roles", ["admin"]],
      ["permissions", ["*"]],
      ["token", "bearer xyz"],
      ["authorization", { scheme: "bearer" }],
      ["credentials", { password: "hunter2" }],
      ["apiKey", "sk-live"],
    ]) {
      assert.throws(
        () => normalizePersonaCanonical({
          schemaVersion: 1, name: "Hostile Persona", [key]: value,
        }),
        (error) => error.code === "PERSONA_DATA_INVALID" && error.key === key,
        `expected ${key} to be rejected`,
      );
    }
    // Nested same-named keys are inert narrative data, not authority claims:
    // only top-level known auth-shaped keys are policed.
    const nested = normalizePersonaCanonical({
      schemaVersion: 1,
      name: "Narrative Persona",
      description: "d",
      backstory: { role: "harbor master", token: "a lucky coin" },
    });
    assert.deepEqual(nested.backstory, { role: "harbor master", token: "a lucky coin" });
  });

  check("non-plain, proxied, accessor, cyclic, and non-finite payloads are rejected", () => {
    assert.throws(
      () => normalizePersonaCanonical(new Proxy({ schemaVersion: 1, name: "Proxied" }, {})),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );

    const accessorCanonical = { schemaVersion: 1, name: "Accessor" };
    Object.defineProperty(accessorCanonical, "futureField", {
      enumerable: true,
      get() { return "sneaky"; },
    });
    assert.throws(
      () => normalizePersonaCanonical(accessorCanonical),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );

    const classCanonical = Object.assign(Object.create({ customPrototype: true }), {
      schemaVersion: 1, name: "Class",
    });
    assert.throws(
      () => normalizePersonaCanonical(classCanonical),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );

    const cyclic = { schemaVersion: 1, name: "Cyclic" };
    cyclic.self = cyclic;
    assert.throws(
      () => normalizePersonaCanonical(cyclic),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );

    assert.throws(
      () => normalizePersonaCanonical({
        schemaVersion: 1, name: "Non-finite", futureField: Number.NaN,
      }),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );

    assert.throws(
      () => normalizePersonaCanonical("not-an-object"),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );
  });

  check("dangerous keys are rejected at every level", () => {
    assert.throws(
      () => normalizePersonaCanonical(
        JSON.parse('{"schemaVersion":1,"name":"Danger","__proto__":{"polluted":true}}'),
      ),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );
    assert.throws(
      () => normalizePersonaCanonical({
        schemaVersion: 1,
        name: "Nested Danger",
        backstory: JSON.parse('{"list":[{"constructor":{}}]}'),
      }),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );
    assert.throws(
      () => normalizePersonaCanonical({
        schemaVersion: 1,
        name: "Prototype Danger",
        backstory: JSON.parse('{"prototype":{}}'),
      }),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );
  });

  check("the plain-data walk enforces depth, node, array, and string bounds", () => {
    let deep = {};
    for (let index = 0; index < 40; index += 1) deep = { next: deep };
    assertPersonaLimit(
      () => normalizePersonaCanonical({
        schemaVersion: 1, name: "Deep Persona", backstory: deep,
      }),
      "dataDepth",
      MAX_PERSONA_DATA_DEPTH,
    );

    // Each element adds 11 nodes (itself plus ten nested objects), so a full
    // array-length fan-out exceeds the node bound before the array bound.
    const fanOut = Array.from({ length: MAX_PERSONA_DATA_ARRAY_LENGTH }, () => ({
      a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {}, h: {}, i: {}, j: {},
    }));
    assertPersonaLimit(
      () => normalizePersonaCanonical({
        schemaVersion: 1, name: "Node Flood", backstory: { list: fanOut },
      }),
      "dataNodes",
      MAX_PERSONA_DATA_NODES,
    );

    assertPersonaLimit(
      () => normalizePersonaCanonical({
        schemaVersion: 1,
        name: "Array Flood",
        backstory: { list: new Array(MAX_PERSONA_DATA_ARRAY_LENGTH + 1).fill(0) },
      }),
      "dataArrayLength",
      MAX_PERSONA_DATA_ARRAY_LENGTH,
    );

    assertPersonaLimit(
      () => normalizePersonaCanonical({
        schemaVersion: 1,
        name: "String Flood",
        backstory: { big: "x".repeat(MAX_PERSONA_STRING_CHARS + 1) },
      }),
      "stringChars",
      MAX_PERSONA_STRING_CHARS,
    );
  });

  check("source envelopes are walked trap-free before normalization", () => {
    let getterCalls = 0;
    const trappedSource = { kind: "created", format: "lily", container: "json" };
    Object.defineProperty(trappedSource, "originalFileName", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "trap.json";
      },
    });
    assert.throws(
      () => repository.createPersona({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Trapped Source" },
        source: trappedSource,
      }),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );
    assert.equal(getterCalls, 0);

    assert.throws(
      () => repository.createPersona({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Proxied Source" },
        source: new Proxy({ kind: "created", format: "lily", container: "json" }, {}),
      }),
      (error) => error.code === "PERSONA_DATA_INVALID",
    );
  });

  check("persona limits bound names and descriptions", () => {
    assertPersonaLimit(
      () => normalizePersonaCanonical({
        schemaVersion: 1, name: "n".repeat(MAX_PERSONA_NAME_CHARS + 1),
      }),
      "nameChars",
      MAX_PERSONA_NAME_CHARS,
    );
    assertPersonaLimit(
      () => normalizePersonaCanonical({
        schemaVersion: 1,
        name: "Description Flood",
        description: "d".repeat(MAX_PERSONA_DESCRIPTION_CHARS + 1),
      }),
      "descriptionChars",
      MAX_PERSONA_DESCRIPTION_CHARS,
    );
    assert.throws(
      () => normalizePersonaCanonical({ schemaVersion: 1 }),
      /persona name is required/,
    );
  });

  check("oversized canonical payloads fail closed before persistence", () => {
    const entitiesBefore = freshStore.db.get(
      "SELECT COUNT(*) AS count FROM persona_entities",
    ).count;
    assert.throws(
      () => repository.createPersona({
        ownerScope: OWNER,
        canonical: {
          schemaVersion: 1,
          name: "Oversized Persona",
          // "€" is 3 UTF-8 bytes per char; a max-length preserved string
          // pushes the packed canonical past MAX_PERSONA_CANONICAL_BYTES.
          backstory: { big: "€".repeat(MAX_PERSONA_STRING_CHARS) },
        },
      }),
      (error) => error.code === "PERSONA_DATA_TOO_LARGE"
        && error.limit === MAX_PERSONA_CANONICAL_BYTES,
    );
    assert.equal(
      freshStore.db.get("SELECT COUNT(*) AS count FROM persona_entities").count,
      entitiesBefore,
    );
  });

  check("all persona reads use exact owner-scope isolation", () => {
    assert.deepEqual(repository.listPersonas(OTHER_OWNER), []);
    assert.equal(repository.getPersona(OTHER_OWNER, first.entity.id), null);
    assert.equal(repository.getPersonaRevision(OTHER_OWNER, first.revision.id), null);
    assert.equal(repository.archivePersona(OTHER_OWNER, first.entity.id), null);
    assert.equal(repository.getPersona(OWNER, first.entity.id).archivedAt, null);
    assert.throws(
      () => repository.createPersonaRevision({
        ownerScope: OTHER_OWNER,
        entityId: first.entity.id,
        baseRevisionId: assetRevision.id,
        canonical: { schemaVersion: 1, name: "Cross owner" },
      }),
      (error) => error.code === "PERSONA_NOT_FOUND",
    );
  });

  check("owner-safe foreign keys reject dangling and cross-owner raw writes", () => {
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO persona_entities
           (id, owner_scope, display_name, current_revision_id, archived_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        crypto.randomUUID(), OTHER_OWNER, "Cross owner", first.revision.id,
        Date.now(), Date.now(),
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO persona_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose)
         VALUES (?, ?, ?, ?, ?, ?)`,
        first.revision.id, OWNER, "missing-blob", 1, null, "invalid",
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO persona_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose)
         VALUES (?, ?, ?, ?, ?, ?)`,
        first.revision.id, OTHER_OWNER, avatarHash, avatarBytes.length, "image/png", "invalid-owner",
      ),
      /FOREIGN KEY constraint failed/,
    );
  });

  check("persona revisions expose no update path and reject raw mutation", () => {
    assert.equal(typeof repository.updatePersonaRevision, "undefined");
    assert.equal(typeof repository.updatePersona, "undefined");
    const before = { ...freshStore.db.get(
      `SELECT canonical_hash, revision_hash, display_name
       FROM persona_revisions WHERE id = ?`,
      first.revision.id,
    ) };
    assert.throws(
      () => freshStore.db.run(
        "UPDATE persona_revisions SET canonical_hash = ? WHERE id = ?",
        `sha256:${"f".repeat(64)}`,
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run("DELETE FROM persona_revisions WHERE id = ?", first.revision.id),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "UPDATE persona_revision_blobs SET mime = ? WHERE revision_id = ?",
        "text/plain",
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "DELETE FROM persona_revision_blobs WHERE revision_id = ?",
        first.revision.id,
      ),
      /immutable/,
    );
    assert.deepEqual(
      { ...freshStore.db.get(
        `SELECT canonical_hash, revision_hash, display_name
         FROM persona_revisions WHERE id = ?`,
        first.revision.id,
      ) },
      before,
    );
  });

  check("failed creation rolls back blob files and catalog rows", () => {
    const rollbackBytes = Buffer.from("rollback-only-persona-asset");
    const rollbackHash = crypto.createHash("sha256").update(rollbackBytes).digest("hex");
    const entitiesBefore = freshStore.db.get(
      "SELECT COUNT(*) AS count FROM persona_entities",
    ).count;
    freshStore.db.exec(`
      CREATE TRIGGER test_persona_asset_rollback
      BEFORE INSERT ON persona_revision_blobs
      WHEN NEW.purpose = 'force-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced persona asset rollback');
      END;
    `);
    try {
      assert.throws(
        () => repository.createPersona({
          ownerScope: OWNER,
          canonical: { schemaVersion: 1, name: "Rollback Persona" },
          assets: [{
            purpose: "force-rollback",
            mime: "application/octet-stream",
            data: rollbackBytes,
          }],
        }),
        /forced persona asset rollback/,
      );
      assert.equal(freshStore.blobs.exists(rollbackHash), false);
      assert.equal(
        freshStore.db.get("SELECT 1 FROM blobs WHERE hash = ?", rollbackHash),
        undefined,
      );
      assert.equal(
        freshStore.db.get("SELECT COUNT(*) AS count FROM persona_entities").count,
        entitiesBefore,
      );
    } finally {
      freshStore.db.exec("DROP TRIGGER IF EXISTS test_persona_asset_rollback;");
    }
  });

  check("archive hides a persona without deleting revisions and is idempotent", () => {
    const archived = repository.archivePersona(OWNER, first.entity.id);
    assert.ok(archived.archivedAt);
    assert.ok(
      repository.listPersonas(OWNER).every((entity) => entity.id !== first.entity.id),
    );
    assert.ok(
      repository.listPersonas(OWNER, { includeArchived: true })
        .some((entity) => entity.id === first.entity.id),
    );
    assert.equal(
      repository.getPersonaRevision(OWNER, assetRevision.id).revisionNumber,
      3,
    );
    const reArchived = repository.archivePersona(OWNER, first.entity.id);
    assert.equal(reArchived.archivedAt, archived.archivedAt);
    // No unarchive path exists (Phase 1 archive-only semantics).
    assert.equal(typeof repository.unarchivePersona, "undefined");
  });

  freshStore.close();
  freshStore = null;
  reopenedStore = new MessageStore(freshDbPath, freshBlobDir);
  const reopened = reopenedStore.characterWorlds();

  check("persona entities, revisions, and assets survive reopen", () => {
    assert.equal(reopened.getPersona(OWNER, first.entity.id).currentRevisionId, assetRevision.id);
    const revision = reopened.getPersonaRevision(OWNER, first.revision.id);
    assert.equal(revision.revisionNumber, 1);
    assert.equal(revision.name, "Aurelia Persona");
    assert.deepEqual(revision.canonical, EXPECTED_NORMALIZED_CANONICAL);
    assert.equal(revision.avatarAssetId, avatarHash);
    assert.equal(revision.personaAssets.length, 1);
    assert.equal(reopened.getPersonaRevision(OWNER, assetRevision.id).revisionHash, assetRevision.revisionHash);
  });

  console.log(`\ncharacter-persona-store: ${checks} checks passed`);
} finally {
  freshStore?.close();
  reopenedStore?.close();
  migratedStore?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
