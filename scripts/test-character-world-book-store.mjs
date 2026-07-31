// Character Worlds world-book persistence contract (Phase 2, Task WB-1).
// Run: node scripts/test-character-world-book-store.mjs
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
  MAX_WORLD_BOOK_CANONICAL_BYTES,
  MAX_WORLD_BOOK_CONTENT_CHARS,
  MAX_WORLD_BOOK_DATA_ARRAY_LENGTH,
  MAX_WORLD_BOOK_DATA_DEPTH,
  MAX_WORLD_BOOK_DATA_NODES,
  MAX_WORLD_BOOK_ENTRIES,
  MAX_WORLD_BOOK_LIMITS_VERSION,
  MAX_WORLD_BOOK_MESSAGE_COUNT,
  MAX_WORLD_BOOK_NAME_CHARS,
  MAX_WORLD_BOOK_STRING_CHARS,
  WORLD_BOOK_SCHEMA_VERSION,
} = require("../src/main/character-worlds/constants.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  normalizeWorldBookCanonical,
} = require("../src/main/character-worlds/world-book-model.js");

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

function assertWorldBookLimit(fn, limitKind, limit) {
  assert.throws(fn, (error) => (
    error.code === "WORLD_BOOK_LIMIT_EXCEEDED"
    && error.limitsVersion === MAX_WORLD_BOOK_LIMITS_VERSION
    && error.limitKind === limitKind
    && error.limit === limit
    && Number.isFinite(error.actual)
  ));
}

const FULL_ENTRY_INPUT = {
  id: "entry-aurelia",
  enabled: false,
  content: "Aurelia's tide-locked port city.",
  activation: {
    constant: true,
    primaryKeys: ["Aurelia", "tide-lock"],
    secondaryKeys: ["harbor"],
    selective: true,
    selectiveLogic: "and_all",
    useRegex: false,
    vectorized: true,
    caseSensitive: true,
    matchWholeWords: true,
    probability: 65,
    inclusionGroups: ["ports"],
    groupWeight: 80,
    prioritizeInclusion: true,
    useGroupScoring: true,
    characterFilter: { mode: "exclude", names: ["Luna"], tags: ["crew"] },
    generationTriggers: ["summary"],
    matchSources: ["description", "scenario"],
    delayMessages: 2,
    stickyMessages: 3,
    cooldownMessages: 4,
  },
  insertion: {
    position: "at_depth",
    depth: 6,
    role: "user",
    outletName: "lore",
    order: 42,
    priority: 7,
  },
  recursion: {
    preventFurtherRecursion: true,
    excludeFromRecursion: true,
    delayUntilRecursion: true,
    recursionLevel: 2,
  },
  preservedDecorators: ["@@reverse_depth 2"],
  preservedExtensions: { vendor: { note: "keep" } },
};

const DEFAULT_ACTIVATION = {
  constant: false,
  primaryKeys: [],
  secondaryKeys: [],
  selective: false,
  selectiveLogic: "and_any",
  useRegex: false,
  vectorized: false,
  caseSensitive: false,
  matchWholeWords: false,
  probability: 100,
  inclusionGroups: [],
  groupWeight: 100,
  prioritizeInclusion: false,
  useGroupScoring: false,
  characterFilter: { mode: "include", characterNames: [], characterTags: [] },
  generationTriggers: [],
  matchSources: [],
  delayMessages: 0,
  stickyMessages: 0,
  cooldownMessages: 0,
  forceState: "none",
  activateOnlyAfter: 0,
  greetingIndex: null,
  scanDepthMessages: 0,
  statefulMatch: "none",
};
const DEFAULT_INSERTION = {
  position: "before_character",
  depth: 4,
  role: "system",
  outletName: "",
  order: 100,
  priority: null,
  reverseDepth: false,
};
const EMPTY_DECORATORS = {
  directives: [],
  inert: [],
  applied: { activation: {}, insertion: {} },
};
const DEFAULT_RECURSION = {
  preventFurtherRecursion: false,
  excludeFromRecursion: false,
  delayUntilRecursion: false,
  recursionLevel: 0,
};
const DEFAULT_SCAN_POLICY = {
  scanDepthMessages: 8,
  includeParticipantNames: true,
  tokenBudget: 0,
  recursive: true,
  maxRecursionSteps: 4,
  minActivations: 0,
  maxDepthMessages: 0,
};

const SCAN_POLICY_INPUT = {
  scanDepthMessages: 12,
  includeParticipantNames: false,
  tokenBudget: 512,
  recursive: false,
  maxRecursionSteps: 6,
  minActivations: 1,
  maxDepthMessages: 24,
};

const EXPECTED_FULL_ENTRY = {
  ...FULL_ENTRY_INPUT,
  activation: {
    ...FULL_ENTRY_INPUT.activation,
    // names/tags input spellings normalize to the spec §7.4 stored shape.
    characterFilter: { mode: "exclude", characterNames: ["Luna"], characterTags: ["crew"] },
    forceState: "none",
    activateOnlyAfter: 0,
    greetingIndex: null,
    scanDepthMessages: 0,
    statefulMatch: "none",
  },
  insertion: { ...FULL_ENTRY_INPUT.insertion, reverseDepth: false },
  decorators: { ...EMPTY_DECORATORS },
};

const EXPECTED_NORMALIZED_CANONICAL = {
  schemaVersion: WORLD_BOOK_SCHEMA_VERSION,
  name: "Aurelia Atlas",
  entries: [
    EXPECTED_FULL_ENTRY,
    {
      id: "entry-1",
      enabled: true,
      content: "Fallback lore.",
      activation: DEFAULT_ACTIVATION,
      insertion: DEFAULT_INSERTION,
      recursion: DEFAULT_RECURSION,
      decorators: { ...EMPTY_DECORATORS },
      preservedDecorators: [],
      preservedExtensions: {},
    },
  ],
  scanPolicy: SCAN_POLICY_INPUT,
};

const bookCanonical = {
  schemaVersion: 1,
  name: "Aurelia Atlas",
  entries: [FULL_ENTRY_INPUT, { content: "Fallback lore." }],
  scanPolicy: SCAN_POLICY_INPUT,
};
const bookSource = {
  kind: "imported",
  format: "character_card_v3",
  container: "json",
  originalFileName: "atlas.json",
};
const coverBytes = Buffer.from("local-private-book-cover");
const coverAsset = { purpose: "cover", mime: "image/png", data: coverBytes };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-world-book-store-"));
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
  check("migrations v3-v12 upgrade a v2 database additively", () => {
    assert.equal(migratedStore.db.pragma("user_version"), 12);
    assert.equal(migratedStore.meta("v2-probe"), "preserved");
    const revisionColumns = tableColumns(migratedStore.db, "world_book_revisions");
    for (const column of [
      "display_name", "source_kind", "source_format", "source_container",
      "source_json", "revision_hash", "original_hash",
    ]) {
      assert.ok(revisionColumns.includes(column), `missing world_book_revisions.${column}`);
    }
    assert.ok(migratedStore.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'world_book_revision_blobs'",
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
      `INSERT INTO world_book_entities
         (id, owner_scope, display_name, current_revision_id, archived_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      legacyEntityId, OWNER, "Legacy Book", legacyRevisionIds[0], 1000, 1000,
    );
    for (const [index, revisionId] of legacyRevisionIds.entries()) {
      legacyV7.run(
        `INSERT INTO world_book_revisions
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
  check("migration v8 backfills pre-existing rows before the dedup index", () => {
    assert.equal(legacyStore.db.pragma("user_version"), 12);
    const rows = legacyStore.db.all(
      `SELECT id, revision_hash FROM world_book_revisions
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
    assert.equal(pinSeed.pragma("user_version"), 12);
    pinSeed.close();
    const pinDb = openDatabase(pinDbPath);
    assert.equal(pinDb.migrate(MIGRATIONS.slice(0, 7)), 12);
    assert.equal(pinDb.pragma("user_version"), 12);
    pinDb.close();
  });
  const repository = freshStore.characterWorlds();

  check("MessageStore exposes the shared Character Worlds repository", () => {
    assert.ok(repository instanceof CharacterWorldsRepository);
    assert.equal(freshStore.characterWorlds(), repository);
  });

  check("a fresh database contains the world-book parity tables", () => {
    const tables = new Set(freshStore.db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name));
    for (const table of [
      "world_book_entities",
      "world_book_revisions",
      "world_book_revision_blobs",
    ]) {
      assert.ok(tables.has(table), `missing ${table}`);
    }
  });

  check("world-book tables carry the character revision discipline", () => {
    const entityColumns = tableColumns(freshStore.db, "world_book_entities");
    for (const column of [
      "id", "owner_scope", "display_name", "current_revision_id",
      "archived_at", "created_at", "updated_at",
    ]) {
      assert.ok(entityColumns.includes(column), `missing world_book_entities.${column}`);
    }
    const revisionColumns = tableColumns(freshStore.db, "world_book_revisions");
    for (const column of [
      "id", "entity_id", "owner_scope", "parent_revision_id", "revision_number",
      "display_name", "source_kind", "source_format", "source_container",
      "canonical_json", "source_json", "canonical_hash", "original_hash",
      "revision_hash", "created_at",
    ]) {
      assert.ok(revisionColumns.includes(column), `missing world_book_revisions.${column}`);
    }
    const blobColumns = tableColumns(freshStore.db, "world_book_revision_blobs");
    for (const column of ["revision_id", "owner_scope", "hash", "bytes", "mime", "purpose"]) {
      assert.ok(blobColumns.includes(column), `missing world_book_revision_blobs.${column}`);
    }
  });

  check("world-book parity indexes exist", () => {
    const indexes = new Set(freshStore.db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).map((row) => row.name));
    for (const index of [
      "idx_world_book_entities_owner",
      "idx_world_book_revision_hash",
      "idx_world_book_revisions_id_owner",
      "idx_world_book_revision_content_hash",
      "idx_world_book_revision_owner_original",
      "idx_world_book_revision_owner_canonical",
    ]) {
      assert.ok(indexes.has(index), `missing ${index}`);
    }
  });

  check("character tables are untouched by the world-book migration", () => {
    const revisionColumns = tableColumns(freshStore.db, "character_revisions");
    for (const column of [
      "display_name", "source_kind", "canonical_json", "canonical_hash",
      "original_hash", "revision_hash",
    ]) {
      assert.ok(revisionColumns.includes(column), `missing character_revisions.${column}`);
    }
    assert.equal(
      freshStore.db.get("SELECT COUNT(*) AS count FROM character_entities").count,
      0,
    );
  });

  const first = repository.createWorldBook({
    ownerScope: OWNER,
    canonical: bookCanonical,
    source: bookSource,
    assets: [coverAsset],
  });

  check("world-book creation atomically creates an immutable first revision", () => {
    assert.equal(first.entity.currentRevisionId, first.revision.id);
    assert.equal(first.entity.displayName, "Aurelia Atlas");
    assert.equal(first.entity.ownerScope, OWNER);
    assert.equal(first.entity.archivedAt, null);
    assert.equal(first.revision.worldBookId, first.entity.id);
    assert.equal(first.revision.parentRevisionId, null);
    assert.equal(first.revision.revisionNumber, 1);
    assert.equal(first.revision.name, "Aurelia Atlas");
    assert.match(first.revision.revisionHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.revision.source, bookSource);
  });

  check("entries are normalized to the bounded §7.4 revision shape", () => {
    const stored = repository.getWorldBookRevision(OWNER, first.revision.id);
    assert.deepEqual(stored.canonical, EXPECTED_NORMALIZED_CANONICAL);
    assert.equal(stored.contentHash, expectedHash(EXPECTED_NORMALIZED_CANONICAL));
  });

  check("asset bytes are cataloged and linked to the world-book revision", () => {
    const hash = crypto.createHash("sha256").update(coverBytes).digest("hex");
    assert.deepEqual(first.revision.bookAssets, [{
      hash,
      bytes: coverBytes.length,
      mime: "image/png",
      purpose: "cover",
    }]);
    assert.ok(freshStore.blobs.exists(hash));
    assert.deepEqual(
      { ...freshStore.db.get("SELECT hash, bytes, mime, refcount FROM blobs WHERE hash = ?", hash) },
      { hash, bytes: coverBytes.length, mime: "image/png", refcount: 1 },
    );
    assert.deepEqual(
      { ...freshStore.db.get(
        `SELECT revision_id, owner_scope, hash, purpose
         FROM world_book_revision_blobs WHERE revision_id = ?`,
        first.revision.id,
      ) },
      { revision_id: first.revision.id, owner_scope: OWNER, hash, purpose: "cover" },
    );
  });

  check("identical revision envelopes dedupe to the existing revision id", () => {
    const reordered = {
      scanPolicy: Object.fromEntries(Object.entries(SCAN_POLICY_INPUT).reverse()),
      entries: [
        Object.fromEntries(Object.entries(FULL_ENTRY_INPUT).reverse()),
        { content: "Fallback lore." },
      ],
      name: "Aurelia Atlas",
      schemaVersion: 1,
    };
    const deduped = repository.createWorldBookRevision({
      ownerScope: OWNER,
      entityId: first.entity.id,
      baseRevisionId: first.revision.id,
      canonical: reordered,
      source: { ...bookSource },
      assets: [{ ...coverAsset }],
    });
    assert.equal(deduped.id, first.revision.id);
    assert.equal(deduped.revisionHash, first.revision.revisionHash);
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM world_book_revisions WHERE entity_id = ?",
        first.entity.id,
      ).count,
      1,
    );
    assert.equal(repository.getWorldBook(OWNER, first.entity.id).currentRevisionId, first.revision.id);
  });

  const changedSource = { ...bookSource, originalFileName: "atlas-copy.json" };
  const sourceRevision = repository.createWorldBookRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: first.revision.id,
    canonical: { ...bookCanonical, entries: [...bookCanonical.entries] },
    source: changedSource,
    assets: [{ ...coverAsset }],
  });

  check("revision hash covers provenance as well as canonical data", () => {
    assert.notEqual(sourceRevision.id, first.revision.id);
    assert.equal(sourceRevision.contentHash, first.revision.contentHash);
    assert.notEqual(sourceRevision.revisionHash, first.revision.revisionHash);
    assert.equal(sourceRevision.revisionNumber, 2);
    assert.equal(sourceRevision.parentRevisionId, first.revision.id);
    assert.deepEqual(sourceRevision.source, changedSource);
    assert.equal(repository.getWorldBook(OWNER, first.entity.id).currentRevisionId, sourceRevision.id);
  });

  const alternateCoverBytes = Buffer.from("different-local-book-cover");
  const assetRevision = repository.createWorldBookRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: sourceRevision.id,
    canonical: { ...bookCanonical, entries: [...bookCanonical.entries] },
    source: changedSource,
    assets: [{ purpose: "cover", mime: "image/png", data: alternateCoverBytes }],
  });

  check("revision hash covers linked assets", () => {
    const alternateHash = crypto.createHash("sha256").update(alternateCoverBytes).digest("hex");
    assert.notEqual(assetRevision.id, sourceRevision.id);
    assert.equal(assetRevision.contentHash, sourceRevision.contentHash);
    assert.notEqual(assetRevision.revisionHash, sourceRevision.revisionHash);
    assert.equal(assetRevision.revisionNumber, 3);
    assert.equal(assetRevision.bookAssets[0].hash, alternateHash);
    assert.ok(freshStore.blobs.exists(alternateHash));
  });

  check("a stale base revision fails without replacing current", () => {
    assert.throws(
      () => repository.createWorldBookRevision({
        ownerScope: OWNER,
        entityId: first.entity.id,
        baseRevisionId: first.revision.id,
        canonical: { schemaVersion: 1, name: "Stale edit" },
      }),
      (error) => error.code === "WORLD_BOOK_REVISION_CONFLICT"
        && error.currentRevisionId === assetRevision.id,
    );
    assert.equal(
      repository.getWorldBook(OWNER, first.entity.id).currentRevisionId,
      assetRevision.id,
    );
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM world_book_revisions WHERE entity_id = ?",
        first.entity.id,
      ).count,
      3,
    );
  });

  check("revisions against a missing entity fail loud", () => {
    assert.throws(
      () => repository.createWorldBookRevision({
        ownerScope: OWNER,
        entityId: crypto.randomUUID(),
        baseRevisionId: crypto.randomUUID(),
        canonical: { schemaVersion: 1, name: "Ghost" },
      }),
      (error) => error.code === "WORLD_BOOK_NOT_FOUND",
    );
  });

  check("unknown fields are preserved inert at every level", () => {
    const hostile = repository.createWorldBook({
      ownerScope: OWNER,
      canonical: {
        schemaVersion: 1,
        name: "Future Book",
        futureBookField: { nested: ["preserve", 1] },
        entries: [{
          id: "future-entry",
          content: "kept",
          futureField: { x: 1 },
          activation: { primaryKeys: ["a"], futureToggle: true },
          insertion: { futurePositionHint: "somewhere" },
          recursion: { futureRecursionFlag: false },
        }],
        scanPolicy: { ...DEFAULT_SCAN_POLICY, futurePolicy: "strict" },
      },
      source: { kind: "imported", format: "character_card_v3", container: "json" },
    });
    const stored = repository.getWorldBookRevision(OWNER, hostile.revision.id).canonical;
    assert.deepEqual(stored.futureBookField, { nested: ["preserve", 1] });
    assert.deepEqual(stored.entries[0].futureField, { x: 1 });
    assert.equal(stored.entries[0].activation.futureToggle, true);
    assert.equal(stored.entries[0].activation.selectiveLogic, "and_any");
    assert.equal(stored.entries[0].insertion.futurePositionHint, "somewhere");
    assert.equal(stored.entries[0].insertion.position, "before_character");
    assert.equal(stored.entries[0].recursion.futureRecursionFlag, false);
    assert.equal(stored.scanPolicy.futurePolicy, "strict");
    assert.equal(stored.scanPolicy.scanDepthMessages, 8);
  });

  check("invalid enums fall back to documented defaults", () => {
    const normalized = normalizeWorldBookCanonical({
      schemaVersion: 1,
      name: "Enum Book",
      entries: [{
        id: "enum-entry",
        content: "x",
        activation: {
          selectiveLogic: "or_maybe",
          characterFilter: { mode: "sometimes", characterNames: ["Luna"], characterTags: ["crew"] },
        },
        insertion: { position: "everywhere", role: "overlord" },
      }],
    });
    const [entry] = normalized.entries;
    assert.equal(entry.activation.selectiveLogic, "and_any");
    assert.equal(entry.activation.characterFilter.mode, "include");
    assert.deepEqual(entry.activation.characterFilter.characterNames, ["Luna"]);
    assert.deepEqual(entry.activation.characterFilter.characterTags, ["crew"]);
    assert.equal(entry.insertion.position, "before_character");
    assert.equal(entry.insertion.role, "system");
  });

  check("characterFilter spellings merge deduplicated into the spec shape", () => {
    const normalized = normalizeWorldBookCanonical({
      schemaVersion: 1,
      name: "Alias Book",
      entries: [{
        id: "alias-entry",
        content: "x",
        activation: {
          characterFilter: {
            mode: "exclude",
            names: ["Luna", "Aurelia"],
            characterNames: ["Aurelia", "Kestrel"],
            tags: ["crew"],
            characterTags: ["crew", "harbor"],
          },
        },
      }],
    });
    assert.deepEqual(normalized.entries[0].activation.characterFilter, {
      mode: "exclude",
      characterNames: ["Aurelia", "Kestrel", "Luna"],
      characterTags: ["crew", "harbor"],
    });
  });

  check("duplicate entry ids are rejected, including generated fallback collisions", () => {
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Duplicate Ids",
        entries: [
          { id: "same", content: "a" },
          { id: "same", content: "b" },
        ],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID" && error.entryId === "same",
    );
    // The second entry gets the generated fallback id "entry-1", which the
    // first entry claims explicitly.
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Fallback Collision",
        entries: [
          { id: "entry-1", content: "a" },
          { content: "b" },
        ],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID" && error.entryId === "entry-1",
    );
  });

  check("numeric fields are clamped into their bounded ranges", () => {
    const normalized = normalizeWorldBookCanonical({
      schemaVersion: 1,
      name: "Numeric Book",
      entries: [{
        id: "numeric-entry",
        content: "x",
        activation: {
          probability: 250,
          groupWeight: -3,
          delayMessages: -9,
          stickyMessages: Number.MAX_SAFE_INTEGER,
          cooldownMessages: "later",
        },
        insertion: { depth: 4.9, order: 101.7, priority: "high" },
      }],
      scanPolicy: { scanDepthMessages: 10 ** 15, tokenBudget: -1 },
    });
    const [entry] = normalized.entries;
    assert.equal(entry.activation.probability, 100);
    assert.equal(entry.activation.groupWeight, 0);
    assert.equal(entry.activation.delayMessages, 0);
    assert.equal(entry.activation.stickyMessages, MAX_WORLD_BOOK_MESSAGE_COUNT);
    assert.equal(entry.activation.cooldownMessages, 0);
    assert.equal(entry.insertion.depth, 4);
    assert.equal(entry.insertion.order, 101);
    assert.equal(entry.insertion.priority, null);
    assert.equal(normalized.scanPolicy.scanDepthMessages, MAX_WORLD_BOOK_MESSAGE_COUNT);
    assert.equal(normalized.scanPolicy.tokenBudget, 0);

    const low = normalizeWorldBookCanonical({
      schemaVersion: 1,
      name: "Low Probability",
      entries: [{ id: "p", content: "x", activation: { probability: -5 } }],
    });
    assert.equal(low.entries[0].activation.probability, 0);
  });

  check("non-plain, proxied, accessor, and cyclic payloads are rejected", () => {
    const proxyEntry = new Proxy({ id: "proxied", content: "x" }, {});
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1, name: "Proxy Book", entries: [proxyEntry],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );

    const accessorEntry = { id: "accessor-entry", content: "x" };
    Object.defineProperty(accessorEntry, "futureField", {
      enumerable: true,
      get() { return "sneaky"; },
    });
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1, name: "Accessor Book", entries: [accessorEntry],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );

    const classEntry = Object.assign(Object.create({ customPrototype: true }), {
      id: "class-entry",
      content: "x",
    });
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1, name: "Class Book", entries: [classEntry],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );

    const cyclicExtensions = { keep: true };
    cyclicExtensions.self = cyclicExtensions;
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Cyclic Book",
        entries: [{ id: "c", content: "x", preservedExtensions: cyclicExtensions }],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );

    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1, name: "Bad Entries", entries: "not-an-array",
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );

    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Non-finite Book",
        entries: [{ id: "n", content: "x", futureField: Number.NaN }],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );
  });

  check("dangerous keys are rejected at every level", () => {
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Entry Danger",
        entries: [JSON.parse('{"id":"k","content":"x","__proto__":{"polluted":true}}')],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Activation Danger",
        entries: [{ id: "k", content: "x", activation: JSON.parse('{"constructor":{}}') }],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );
    assert.throws(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Nested Danger",
        entries: [{
          id: "k",
          content: "x",
          preservedExtensions: JSON.parse('{"list":[{"prototype":{}}]}'),
        }],
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );
  });

  check("the plain-data walk enforces depth, node, array, and string bounds", () => {
    let deep = {};
    for (let index = 0; index < 40; index += 1) deep = { next: deep };
    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Deep Book",
        entries: [{ id: "d", content: "x", preservedExtensions: deep }],
      }),
      "dataDepth",
      MAX_WORLD_BOOK_DATA_DEPTH,
    );

    const fanOut = Array.from({ length: MAX_WORLD_BOOK_DATA_ARRAY_LENGTH }, () => ({}));
    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Node Flood",
        entries: [{ id: "n", content: "x", preservedExtensions: { list: fanOut } }],
      }),
      "dataNodes",
      MAX_WORLD_BOOK_DATA_NODES,
    );

    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Array Flood",
        entries: [{
          id: "a",
          content: "x",
          preservedExtensions: { list: new Array(MAX_WORLD_BOOK_DATA_ARRAY_LENGTH + 1).fill(0) },
        }],
      }),
      "dataArrayLength",
      MAX_WORLD_BOOK_DATA_ARRAY_LENGTH,
    );

    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "String Flood",
        entries: [{
          id: "s",
          content: "x",
          preservedExtensions: { big: "x".repeat(MAX_WORLD_BOOK_STRING_CHARS + 1) },
        }],
      }),
      "stringChars",
      MAX_WORLD_BOOK_STRING_CHARS,
    );
  });

  check("source envelopes are walked trap-free before normalization", () => {
    let getterCalls = 0;
    const trappedSource = { kind: "imported", format: "character_card_v3", container: "json" };
    Object.defineProperty(trappedSource, "originalFileName", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "trap.json";
      },
    });
    assert.throws(
      () => repository.createWorldBook({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Trapped Source" },
        source: trappedSource,
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );
    assert.equal(getterCalls, 0);

    assert.throws(
      () => repository.createWorldBook({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Proxied Source" },
        source: new Proxy(
          { kind: "imported", format: "character_card_v3", container: "json" },
          {},
        ),
      }),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID",
    );
  });

  check("world-book limits bound entries, strings, and names", () => {
    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Entry Flood",
        entries: Array.from({ length: MAX_WORLD_BOOK_ENTRIES + 1 }, (_, index) => ({
          id: `flood-${index}`,
          content: "x",
        })),
      }),
      "entries",
      MAX_WORLD_BOOK_ENTRIES,
    );
    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Content Flood",
        entries: [{ id: "big", content: "x".repeat(MAX_WORLD_BOOK_CONTENT_CHARS + 1) }],
      }),
      "entryContentChars",
      MAX_WORLD_BOOK_CONTENT_CHARS,
    );
    assertWorldBookLimit(
      () => normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "n".repeat(MAX_WORLD_BOOK_NAME_CHARS + 1),
      }),
      "nameChars",
      MAX_WORLD_BOOK_NAME_CHARS,
    );
  });

  check("oversized canonical payloads fail closed before persistence", () => {
    const entitiesBefore = freshStore.db.get(
      "SELECT COUNT(*) AS count FROM world_book_entities",
    ).count;
    assert.throws(
      () => repository.createWorldBook({
        ownerScope: OWNER,
        canonical: {
          schemaVersion: 1,
          name: "Oversized Book",
          entries: Array.from({ length: 3 }, (_, index) => ({
            id: `oversized-${index}`,
            content: "€".repeat(MAX_WORLD_BOOK_CONTENT_CHARS),
          })),
        },
      }),
      (error) => error.code === "WORLD_BOOK_DATA_TOO_LARGE"
        && error.limit === MAX_WORLD_BOOK_CANONICAL_BYTES,
    );
    assert.equal(
      freshStore.db.get("SELECT COUNT(*) AS count FROM world_book_entities").count,
      entitiesBefore,
    );
  });

  check("all world-book reads use exact owner-scope isolation", () => {
    assert.deepEqual(repository.listWorldBooks(OTHER_OWNER), []);
    assert.equal(repository.getWorldBook(OTHER_OWNER, first.entity.id), null);
    assert.equal(repository.getWorldBookRevision(OTHER_OWNER, first.revision.id), null);
    assert.equal(repository.archiveWorldBook(OTHER_OWNER, first.entity.id), null);
    assert.equal(repository.getWorldBook(OWNER, first.entity.id).archivedAt, null);
    assert.throws(
      () => repository.createWorldBookRevision({
        ownerScope: OTHER_OWNER,
        entityId: first.entity.id,
        baseRevisionId: assetRevision.id,
        canonical: { schemaVersion: 1, name: "Cross owner" },
      }),
      (error) => error.code === "WORLD_BOOK_NOT_FOUND",
    );
  });

  check("owner-safe foreign keys reject dangling and cross-owner raw writes", () => {
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO world_book_entities
           (id, owner_scope, display_name, current_revision_id, archived_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        crypto.randomUUID(), OTHER_OWNER, "Cross owner", first.revision.id,
        Date.now(), Date.now(),
      ),
      /FOREIGN KEY constraint failed/,
    );
    const coverHash = first.revision.bookAssets[0].hash;
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO world_book_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose)
         VALUES (?, ?, ?, ?, ?, ?)`,
        first.revision.id, OWNER, "missing-blob", 1, null, "invalid",
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO world_book_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose)
         VALUES (?, ?, ?, ?, ?, ?)`,
        first.revision.id, OTHER_OWNER, coverHash, coverBytes.length, "image/png", "invalid-owner",
      ),
      /FOREIGN KEY constraint failed/,
    );
  });

  check("world-book revisions expose no update path and reject raw mutation", () => {
    assert.equal(typeof repository.updateWorldBookRevision, "undefined");
    assert.equal(typeof repository.updateWorldBook, "undefined");
    const before = { ...freshStore.db.get(
      `SELECT canonical_hash, revision_hash, display_name
       FROM world_book_revisions WHERE id = ?`,
      first.revision.id,
    ) };
    assert.throws(
      () => freshStore.db.run(
        "UPDATE world_book_revisions SET canonical_hash = ? WHERE id = ?",
        `sha256:${"f".repeat(64)}`,
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run("DELETE FROM world_book_revisions WHERE id = ?", first.revision.id),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "UPDATE world_book_revision_blobs SET mime = ? WHERE revision_id = ?",
        "text/plain",
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "DELETE FROM world_book_revision_blobs WHERE revision_id = ?",
        first.revision.id,
      ),
      /immutable/,
    );
    assert.deepEqual(
      { ...freshStore.db.get(
        `SELECT canonical_hash, revision_hash, display_name
         FROM world_book_revisions WHERE id = ?`,
        first.revision.id,
      ) },
      before,
    );
  });

  check("failed creation rolls back blob files and catalog rows", () => {
    const rollbackBytes = Buffer.from("rollback-only-world-book-asset");
    const rollbackHash = crypto.createHash("sha256").update(rollbackBytes).digest("hex");
    const entitiesBefore = freshStore.db.get(
      "SELECT COUNT(*) AS count FROM world_book_entities",
    ).count;
    freshStore.db.exec(`
      CREATE TRIGGER test_world_book_asset_rollback
      BEFORE INSERT ON world_book_revision_blobs
      WHEN NEW.purpose = 'force-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced world book asset rollback');
      END;
    `);
    try {
      assert.throws(
        () => repository.createWorldBook({
          ownerScope: OWNER,
          canonical: { schemaVersion: 1, name: "Rollback Book" },
          assets: [{
            purpose: "force-rollback",
            mime: "application/octet-stream",
            data: rollbackBytes,
          }],
        }),
        /forced world book asset rollback/,
      );
      assert.equal(freshStore.blobs.exists(rollbackHash), false);
      assert.equal(
        freshStore.db.get("SELECT 1 FROM blobs WHERE hash = ?", rollbackHash),
        undefined,
      );
      assert.equal(
        freshStore.db.get("SELECT COUNT(*) AS count FROM world_book_entities").count,
        entitiesBefore,
      );
    } finally {
      freshStore.db.exec("DROP TRIGGER IF EXISTS test_world_book_asset_rollback;");
    }
  });

  check("archive hides a world book without deleting revisions", () => {
    const archived = repository.archiveWorldBook(OWNER, first.entity.id);
    assert.ok(archived.archivedAt);
    assert.ok(
      repository.listWorldBooks(OWNER).every((entity) => entity.id !== first.entity.id),
    );
    assert.ok(
      repository.listWorldBooks(OWNER, { includeArchived: true })
        .some((entity) => entity.id === first.entity.id),
    );
    assert.equal(
      repository.getWorldBookRevision(OWNER, assetRevision.id).revisionNumber,
      3,
    );
    const reArchived = repository.archiveWorldBook(OWNER, first.entity.id);
    assert.equal(reArchived.archivedAt, archived.archivedAt);
  });

  freshStore.close();
  freshStore = null;
  reopenedStore = new MessageStore(freshDbPath, freshBlobDir);
  const reopened = reopenedStore.characterWorlds();

  check("world-book entities, revisions, and assets survive reopen", () => {
    assert.equal(reopened.getWorldBook(OWNER, first.entity.id).currentRevisionId, assetRevision.id);
    const revision = reopened.getWorldBookRevision(OWNER, first.revision.id);
    assert.equal(revision.revisionNumber, 1);
    assert.equal(revision.name, "Aurelia Atlas");
    assert.deepEqual(revision.canonical, EXPECTED_NORMALIZED_CANONICAL);
    assert.equal(revision.bookAssets.length, 1);
    assert.equal(reopened.getWorldBookRevision(OWNER, assetRevision.id).revisionHash, assetRevision.revisionHash);
  });

  console.log(`\ncharacter-world-book-store: ${checks} checks passed`);
} finally {
  freshStore?.close();
  reopenedStore?.close();
  migratedStore?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
