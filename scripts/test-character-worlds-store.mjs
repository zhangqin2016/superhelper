// Character Worlds schema and immutable repository contract.
// Run: node scripts/test-character-worlds-store.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BlobStore } = require("../src/main/store/blob-store.js");
const { MessageStore } = require("../src/main/store/message-store.js");
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");
const {
  CHARACTER_ASSET_LIMITS_VERSION,
  CHARACTER_BLOB_RECONCILE_CURSOR_KEY,
  CHARACTER_COMPATIBILITY_PROFILE,
  MAX_CHARACTER_ASSET_BYTES,
  MAX_CHARACTER_ASSET_COUNT,
  MAX_CHARACTER_ASSET_MIME_BYTES,
  MAX_CHARACTER_ASSET_PURPOSE_BYTES,
  MAX_CHARACTER_ASSET_TOTAL_BYTES,
  MAX_CHARACTER_BINDING_BYTES,
  MAX_CHARACTER_SOURCE_BYTES,
  MAX_CHARACTER_TEXT_FIELD_BYTES,
} = require("../src/main/character-worlds/constants.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  CharacterAssetLifecycle,
} = require("../src/main/character-worlds/asset-lifecycle.js");

const OWNER = "profile:local";
const OTHER_OWNER = "profile:local:child";
const EXPECTED_NATIVE = (sessionId) => ({
  schemaVersion: 1,
  sessionId,
  mode: "native",
  bindingVersion: 0,
  characterRevisionId: null,
  personaRevisionId: null,
  compatibilityProfile: null,
  greetingIndex: null,
});

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

function assertOwnerColumn(db, table) {
  assert.ok(tableColumns(db, table).includes("owner_scope"), `${table} must be owner-scoped`);
}

function blobHashesOnDisk(blobDir) {
  if (!fs.existsSync(blobDir)) return [];
  return fs.readdirSync(blobDir).flatMap((shard) => {
    const shardDir = path.join(blobDir, shard);
    return fs.statSync(shardDir).isDirectory() ? fs.readdirSync(shardDir) : [];
  }).filter((name) => !name.includes(".tmp-")).sort();
}

function assertAssetLimit(fn, limitKind, limit) {
  assert.throws(fn, (error) => (
    error.code === "CHARACTER_ASSET_LIMIT_EXCEEDED"
    && error.limitsVersion === CHARACTER_ASSET_LIMITS_VERSION
    && error.limitKind === limitKind
    && error.limit === limit
    && Number.isFinite(error.actual)
  ));
}

function makeBlobTemp(blobStore, data, { pid = 4242, stale = true } = {}) {
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  const finalPath = blobStore.pathFor(hash);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${pid}-${data.byteLength}`;
  fs.writeFileSync(tempPath, data);
  if (stale) {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(tempPath, staleTime, staleTime);
  }
  return { hash, finalPath, tempPath };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-worlds-store-"));
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
  v2.run(
    `INSERT INTO turn_inputs
       (session_id, admitted_seq, turn_id, delivery, status, user_text,
        files_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "legacy-admission-session",
    1,
    "legacy-admission-turn",
    "queue",
    "admitted",
    "legacy durable queue",
    "[]",
    JSON.stringify({
      queueRecovery: {
        schemaVersion: 1,
        kind: "durable_queue",
        queueItemId: "legacy-admission-item",
        displayFiles: [],
        options: {
          scheduledTaskRunId: "legacy-scheduled-run",
          externalCommand: {
            commandId: "legacy-external-command",
            idempotencyKey: "legacy-external-key",
            payloadHash: "legacy-external-hash",
          },
        },
      },
    }),
    1000,
  );
  assert.equal(v2.pragma("user_version"), 2);
  v2.close();

  migratedStore = new MessageStore(migratedDbPath, migratedBlobDir);
  check("migrations v3-v13 upgrade a v2 database additively", () => {
    assert.equal(migratedStore.db.pragma("user_version"), 13);
    assert.equal(migratedStore.meta("v2-probe"), "preserved");
    const turnInputColumns = new Set(
      migratedStore.db.all("PRAGMA table_info(turn_inputs)").map((row) => row.name),
    );
    assert.equal(turnInputColumns.has("dispatch_attempt_id"), true);
    assert.equal(turnInputColumns.has("dispatch_started_at"), true);
    assert.equal(turnInputColumns.has("accepted_at"), true);
    assert.equal(turnInputColumns.has("external_desktop_device_id"), true);
    assert.equal(turnInputColumns.has("external_mobile_device_id"), true);
    assert.equal(turnInputColumns.has("owner_scope"), true);
    assert.equal(turnInputColumns.has("migration_status"), true);
    assert.equal(turnInputColumns.has("scheduled_task_run_id"), true);
    assert.equal(turnInputColumns.has("external_command_id"), true);
    assert.equal(turnInputColumns.has("external_idempotency_key"), true);
    assert.equal(turnInputColumns.has("external_payload_hash"), true);
    const backfilled = migratedStore.db.get(
      "SELECT * FROM turn_inputs WHERE turn_id = ?",
      "legacy-admission-turn",
    );
    assert.equal(backfilled.owner_scope, "legacy_ambiguous");
    assert.equal(backfilled.migration_status, "legacy_ambiguous");
    assert.equal(backfilled.scheduled_task_run_id, "legacy-scheduled-run");
    assert.equal(backfilled.external_command_id, "legacy-external-command");
    assert.equal(backfilled.external_idempotency_key, "legacy-external-key");
    assert.equal(backfilled.external_payload_hash, "legacy-external-hash");
  });

  freshStore = new MessageStore(freshDbPath, freshBlobDir);
  const repository = freshStore.characterWorlds();

  check("MessageStore exposes one lazy Character Worlds repository", () => {
    assert.ok(repository instanceof CharacterWorldsRepository);
    assert.equal(freshStore.characterWorlds(), repository);
  });

  const lazyDbPath = path.join(tmp, "lazy-reconcile.db");
  const lazyBlobDir = path.join(tmp, "lazy-reconcile-blobs");
  const lazySeedStore = new MessageStore(lazyDbPath, lazyBlobDir);
  const lazyOrphan = lazySeedStore.blobs.write(Buffer.from("lazy-stale-orphan"));
  const lazyStaleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(lazySeedStore.blobs.pathFor(lazyOrphan.hash), lazyStaleTime, lazyStaleTime);
  lazySeedStore.close();
  const lazyReopenedStore = new MessageStore(lazyDbPath, lazyBlobDir);

  check("native MessageStore reopen pays no reconciliation cost", () => {
    assert.ok(lazyReopenedStore.blobs.exists(lazyOrphan.hash));
  });

  check("first lazy Character Worlds access reconciles stale crash orphans", () => {
    assert.ok(lazyReopenedStore.characterWorlds() instanceof CharacterWorldsRepository);
    assert.equal(lazyReopenedStore.blobs.exists(lazyOrphan.hash), false);
  });
  lazyReopenedStore.close();

  const failOpenDbPath = path.join(tmp, "fail-open.db");
  const failOpenBlobPath = path.join(tmp, "fail-open-blob-file");
  fs.writeFileSync(failOpenBlobPath, "not a blob directory");
  const failOpenStore = new MessageStore(failOpenDbPath, failOpenBlobPath);
  check("lazy reconciliation failure leaves Character Worlds usable", () => {
    const failOpenRepository = failOpenStore.characterWorlds();
    assert.deepEqual(
      failOpenRepository.getBinding("fail-open-session", OWNER),
      EXPECTED_NATIVE("fail-open-session"),
    );
  });
  failOpenStore.close();

  const progressDbPath = path.join(tmp, "reconcile-progress.db");
  const progressBlobDir = path.join(tmp, "reconcile-progress-blobs");
  let progressStore = new MessageStore(progressDbPath, progressBlobDir);
  const progressRepository = progressStore.characterWorlds();
  const progressRefs = Array.from({ length: 5 }, (_, index) => {
    const data = Buffer.from(`progress-blob-${index}`);
    return { ...progressStore.blobs.write(data), data };
  }).sort((left, right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0);
  for (const ref of progressRefs) {
    fs.utimesSync(progressStore.blobs.pathFor(ref.hash), lazyStaleTime, lazyStaleTime);
  }
  for (const ref of progressRefs.slice(0, -1)) {
    progressStore.db.run(
      `INSERT INTO blobs (hash, bytes, mime, refcount, created_at)
       VALUES (?, ?, ?, 1, ?)`,
      ref.hash,
      ref.bytes,
      "application/octet-stream",
      Date.now(),
    );
  }

  let resumedLifecycle;
  let resumedCursor;
  check("GC cursor survives MessageStore reopen and resumes the bounded scan", () => {
    const firstPass = progressRepository.reconcileOrphanBlobs({ maxFiles: 2, graceMs: 0 });
    const firstCursor = progressStore.meta(CHARACTER_BLOB_RECONCILE_CURSOR_KEY);
    assert.equal(firstPass.scanned, 2);
    assert.equal(firstPass.removed, 0);
    assert.ok(firstCursor);
    assert.ok(progressStore.blobs.exists(progressRefs.at(-1).hash));

    progressStore.close();
    progressStore = new MessageStore(progressDbPath, progressBlobDir);
    assert.equal(progressStore.meta(CHARACTER_BLOB_RECONCILE_CURSOR_KEY), firstCursor);
    resumedLifecycle = new CharacterAssetLifecycle(progressStore.db, progressStore.blobs);
    const secondPass = resumedLifecycle.reconcile({ maxFiles: 2, graceMs: 0 });
    resumedCursor = progressStore.meta(CHARACTER_BLOB_RECONCILE_CURSOR_KEY);
    assert.equal(secondPass.scanned, 2);
    assert.equal(secondPass.removed, 0);
    assert.ok(resumedCursor > firstCursor);
    assert.ok(progressStore.blobs.exists(progressRefs.at(-1).hash));
  });

  check("completed GC namespace wraps to a new lexically earlier orphan", () => {
    const thirdPass = resumedLifecycle.reconcile({ maxFiles: 2, graceMs: 0 });
    assert.equal(thirdPass.scanned, 1);
    assert.deepEqual(thirdPass.removedHashes, [progressRefs.at(-1).hash]);
    assert.equal(progressStore.blobs.exists(progressRefs.at(-1).hash), false);
    assert.equal(progressStore.meta(CHARACTER_BLOB_RECONCILE_CURSOR_KEY), null);

    let wrapIndex = 0;
    let wrapData;
    let wrapHash;
    do {
      wrapData = Buffer.from(`wrapped-orphan-${wrapIndex}`);
      wrapHash = crypto.createHash("sha256").update(wrapData).digest("hex");
      wrapIndex += 1;
    } while (wrapHash >= progressRefs[0].hash);
    const wrapRef = progressStore.blobs.write(wrapData, wrapHash);
    fs.utimesSync(progressStore.blobs.pathFor(wrapHash), lazyStaleTime, lazyStaleTime);
    const wrapKey = `${wrapHash.slice(0, 2)}/${wrapHash}`;
    assert.ok(wrapKey < resumedCursor);

    const wrappedPass = resumedLifecycle.reconcile({ maxFiles: 2, graceMs: 0 });
    assert.deepEqual(wrappedPass.removedHashes, [wrapRef.hash]);
    assert.equal(progressStore.blobs.exists(wrapRef.hash), false);
    for (const ref of progressRefs.slice(0, -1)) {
      assert.ok(progressStore.blobs.exists(ref.hash));
      assert.ok(progressStore.db.get("SELECT 1 FROM blobs WHERE hash = ?", ref.hash));
    }
  });
  progressStore.close();

  const tempDbPath = path.join(tmp, "reconcile-temps.db");
  const tempBlobDir = path.join(tmp, "reconcile-temp-blobs");
  const tempStore = new MessageStore(tempDbPath, tempBlobDir);
  const sharedMessageBytesForTempTest = Buffer.alloc(600 * 1024, 11);
  tempStore.append("temp-shared-session", {
    id: "temp_shared_message",
    role: "user",
    content: "shared blob",
    record: {
      payload: `data:application/octet-stream;base64,${
        sharedMessageBytesForTempTest.toString("base64")
      }`,
    },
  });
  const sharedMessageHashForTempTest = tempStore.db.get(
    "SELECT hash FROM message_blobs WHERE message_id = ?",
    "temp_shared_message",
  ).hash;
  const tempRepository = tempStore.characterWorlds();

  const finalExistsData = Buffer.from("temp-with-existing-final");
  const finalExistsRef = tempStore.blobs.write(finalExistsData);
  tempStore.db.run(
    `INSERT INTO blobs (hash, bytes, mime, refcount, created_at)
     VALUES (?, ?, ?, 1, ?)`,
    finalExistsRef.hash,
    finalExistsRef.bytes,
    "application/octet-stream",
    Date.now(),
  );
  const finalExistsTemp = makeBlobTemp(tempStore.blobs, finalExistsData);
  const noCatalogTemp = makeBlobTemp(tempStore.blobs, Buffer.from("stale-temp-no-catalog"));
  const recoveryData = Buffer.from("cataloged-temp-recovery");
  const recoveryTemp = makeBlobTemp(tempStore.blobs, recoveryData);
  tempStore.db.run(
    `INSERT INTO blobs (hash, bytes, mime, refcount, created_at)
     VALUES (?, ?, ?, 1, ?)`,
    recoveryTemp.hash,
    recoveryData.byteLength,
    "application/octet-stream",
    Date.now(),
  );
  const recentTemp = makeBlobTemp(
    tempStore.blobs,
    Buffer.from("recent-temp-preserved"),
    { stale: false },
  );
  const unknownPath = `${tempStore.blobs.pathFor(recentTemp.hash)}.tmp-not-a-blob-temp`;
  fs.writeFileSync(unknownPath, "unknown");
  fs.utimesSync(unknownPath, lazyStaleTime, lazyStaleTime);
  const nearPatternData = Buffer.from("noncanonical-temp-pattern");
  const nearPatternHash = crypto.createHash("sha256").update(nearPatternData).digest("hex");
  const nearPatternFinal = tempStore.blobs.pathFor(nearPatternHash);
  fs.mkdirSync(path.dirname(nearPatternFinal), { recursive: true });
  const nearPatternPath = `${nearPatternFinal}.tmp-04242-${nearPatternData.byteLength}`;
  fs.writeFileSync(nearPatternPath, nearPatternData);
  fs.utimesSync(nearPatternPath, lazyStaleTime, lazyStaleTime);

  check("stale exact BlobStore temps are cleaned or atomically recovered", () => {
    tempRepository.reconcileOrphanBlobs({ maxFiles: 100, graceMs: 60_000 });
    assert.equal(fs.existsSync(finalExistsTemp.tempPath), false);
    assert.ok(fs.existsSync(finalExistsTemp.finalPath));
    assert.equal(fs.existsSync(noCatalogTemp.tempPath), false);
    assert.equal(fs.existsSync(noCatalogTemp.finalPath), false);
    assert.equal(fs.existsSync(recoveryTemp.tempPath), false);
    assert.deepEqual(fs.readFileSync(recoveryTemp.finalPath), recoveryData);
  });

  check("reconciliation preserves recent temps, unknown files, and shared message blobs", () => {
    assert.ok(fs.existsSync(recentTemp.tempPath));
    assert.ok(fs.existsSync(unknownPath));
    assert.ok(fs.existsSync(nearPatternPath));
    assert.ok(tempStore.blobs.exists(sharedMessageHashForTempTest));
    assert.ok(tempStore.db.get(
      "SELECT 1 FROM blobs WHERE hash = ?",
      sharedMessageHashForTempTest,
    ));
  });
  tempStore.close();

  const canonicalTables = [
    "character_entities",
    "character_revisions",
    "character_revision_blobs",
    "character_session_bindings",
    "character_binding_events",
    "persona_entities",
    "persona_revisions",
    "world_book_entities",
    "world_book_revisions",
    "character_scene_checkpoints",
  ];
  check("a fresh database contains every canonical Phase 1 table", () => {
    const tables = new Set(freshStore.db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name));
    for (const table of canonicalTables) assert.ok(tables.has(table), `missing ${table}`);
  });

  check("canonical owner-scoped tables have exact owner columns", () => {
    for (const table of [
      "character_entities",
      "character_revisions",
      "character_revision_blobs",
      "character_session_bindings",
      "character_binding_events",
      "persona_entities",
      "persona_revisions",
      "world_book_entities",
      "world_book_revisions",
      "character_scene_checkpoints",
    ]) {
      assertOwnerColumn(freshStore.db, table);
    }
  });

  check("character revision schema exposes required metadata columns", () => {
    const entityColumns = tableColumns(freshStore.db, "character_entities");
    const revisionColumns = tableColumns(freshStore.db, "character_revisions");
    assert.ok(entityColumns.includes("display_name"));
    for (const column of [
      "display_name",
      "revision_number",
      "source_kind",
      "source_format",
      "source_container",
      "canonical_hash",
      "original_hash",
      "revision_hash",
    ]) {
      assert.ok(revisionColumns.includes(column), `missing character_revisions.${column}`);
    }
    const blobRefColumns = tableColumns(freshStore.db, "character_revision_blobs");
    assert.ok(blobRefColumns.includes("bytes"), "revision blob refs must store byte length");
    assert.ok(blobRefColumns.includes("mime"), "revision blob refs must store MIME");
  });

  check("forward-compatible tables preserve entity and immutable revision shapes", () => {
    for (const table of ["persona_entities", "world_book_entities"]) {
      const columns = tableColumns(freshStore.db, table);
      for (const column of [
        "id", "owner_scope", "display_name", "current_revision_id",
        "archived_at", "created_at", "updated_at",
      ]) {
        assert.ok(columns.includes(column), `missing ${table}.${column}`);
      }
    }
    for (const table of ["persona_revisions", "world_book_revisions"]) {
      const columns = tableColumns(freshStore.db, table);
      for (const column of [
        "id", "entity_id", "owner_scope", "parent_revision_id", "revision_number",
        "canonical_json", "canonical_hash", "created_at",
      ]) {
        assert.ok(columns.includes(column), `missing ${table}.${column}`);
      }
    }
    const checkpointColumns = tableColumns(freshStore.db, "character_scene_checkpoints");
    for (const column of [
      "id", "session_id", "owner_scope", "turn_id", "checkpoint_json", "created_at",
    ]) {
      assert.ok(checkpointColumns.includes(column), `missing checkpoint.${column}`);
    }
    assert.ok(
      tableColumns(freshStore.db, "character_session_bindings").includes("binding_json"),
      "bindings must keep a versioned JSON envelope",
    );
  });

  check("approved character indexes exist", () => {
    const indexes = new Set(freshStore.db.all(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).map((row) => row.name));
    for (const index of [
      "idx_character_entities_owner",
      "idx_character_revision_hash",
      "idx_character_revision_owner_canonical",
      "idx_character_revision_owner_original",
      "idx_character_binding_event_version",
    ]) {
      assert.ok(indexes.has(index), `missing ${index}`);
    }
  });

  check("import duplicate lookups use owner-first hash indexes", () => {
    const plans = [
      {
        predicate: "r.original_hash = ?",
        hash: "a".repeat(64),
        index: "idx_character_revision_owner_original",
      },
      {
        predicate: "r.canonical_hash = ?",
        hash: `sha256:${"b".repeat(64)}`,
        index: "idx_character_revision_owner_canonical",
      },
    ];
    for (const plan of plans) {
      const details = freshStore.db.all(
        `EXPLAIN QUERY PLAN
         SELECT r.id AS revision_id, r.entity_id
         FROM character_revisions r
         JOIN character_entities e
           ON e.id = r.entity_id AND e.owner_scope = r.owner_scope
         WHERE r.owner_scope = ? AND ${plan.predicate}
         ORDER BY (e.archived_at IS NOT NULL) ASC, r.created_at ASC, r.id ASC
         LIMIT 1`,
        OWNER, plan.hash,
      ).map((row) => row.detail);
      assert(
        details.some((detail) => detail.includes(`USING INDEX ${plan.index}`)),
        `query did not use ${plan.index}: ${details.join("; ")}`,
      );
    }
  });

  const lunaCanonical = {
    schemaVersion: 1,
    name: "Luna",
    description: "Navigator",
  };
  const lunaSource = {
    kind: "imported",
    format: "character_card_v2",
    container: "json",
    originalFileName: "luna.json",
    preserved: { data: { name: "Luna" } },
  };
  const avatarBytes = Buffer.from("local-private-avatar");
  const avatarAsset = { purpose: "avatar", mime: "image/png", data: avatarBytes };
  const first = repository.createCharacter({
    ownerScope: OWNER,
    canonical: lunaCanonical,
    source: lunaSource,
    assets: [avatarAsset],
  });

  const importOwner = "profile:import-dedupe";
  const importedBytes = Buffer.from('{"spec":"chara_card_v3","data":{"name":"Import Dedupe"}}');
  const importedHash = crypto.createHash("sha256").update(importedBytes).digest("hex");
  const importedCanonical = {
    schemaVersion: 1,
    name: "Import Dedupe",
    description: "owner-safe",
  };
  const importedSource = {
    kind: "imported",
    format: "v3_json",
    container: "json",
    original: {
      hash: importedHash,
      bytes: importedBytes.length,
      mime: "application/json",
      purpose: "character-card-original",
    },
    preserved: { schemaVersion: 1, data: { name: "Import Dedupe" } },
  };
  const importInput = {
    ownerScope: importOwner,
    canonical: importedCanonical,
    source: importedSource,
    assets: [{
      purpose: "character-card-original",
      mime: "application/json",
      data: importedBytes,
    }],
  };
  const importedFirst = repository.importCharacter(importInput);

  check("import duplicate queries are owner-scoped and use exact original hashes", () => {
    const found = repository.findImportDuplicates(importOwner, {
      originalHash: importedHash,
      canonicalHash: importedFirst.revision.contentHash,
    });
    assert.deepEqual(found.exact, {
      entityId: importedFirst.entity.id,
      revisionId: importedFirst.revision.id,
    });
    assert.deepEqual(found.canonical, found.exact);
    assert.deepEqual(
      repository.findImportDuplicates(OTHER_OWNER, {
        originalHash: importedHash,
        canonicalHash: importedFirst.revision.contentHash,
      }),
      { exact: null, canonical: null },
    );
  });

  check("exact import duplicate transaction reuses the immutable entity and blob", () => {
    const entitiesBefore = repository.listCharacters(importOwner).length;
    const refsBefore = freshStore.db.get(
      "SELECT refcount FROM blobs WHERE hash = ?",
      importedHash,
    ).refcount;
    const duplicate = repository.importCharacter(importInput);
    assert.equal(duplicate.entity.id, importedFirst.entity.id);
    assert.equal(duplicate.revision.id, importedFirst.revision.id);
    assert.deepEqual(duplicate.duplicate, {
      kind: "exact",
      reused: true,
      resolution: "reuse_existing",
    });
    assert.equal(repository.listCharacters(importOwner).length, entitiesBefore);
    assert.equal(
      freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", importedHash).refcount,
      refsBefore,
    );
  });

  check("blob replacement is verified, atomic, and rollback-capable", () => {
    const replacementDir = path.join(tmp, "blob-replacement");
    const blobStore = new BlobStore(replacementDir);
    const expected = Buffer.from("expected-content-addressed-bytes");
    const hash = BlobStore.hash(expected);
    const corrupt = Buffer.alloc(expected.length, 0x78);
    fs.mkdirSync(path.dirname(blobStore.pathFor(hash)), { recursive: true });
    fs.writeFileSync(blobStore.pathFor(hash), corrupt);

    const rolledBack = blobStore.beginAtomicReplace(expected, hash);
    assert.equal(blobStore.verify(hash, expected.length), true);
    rolledBack.rollback();
    assert.deepEqual(fs.readFileSync(blobStore.pathFor(hash)), corrupt);

    const committed = blobStore.beginAtomicReplace(expected, hash);
    committed.commit();
    assert.equal(blobStore.verify(hash, expected.length), true);
    assert.deepEqual(fs.readFileSync(blobStore.pathFor(hash)), expected);
    assert.deepEqual(
      fs.readdirSync(path.dirname(blobStore.pathFor(hash))),
      [hash],
    );
  });

  check("blob replacement backup cleanup is retryable and exposes pending state", () => {
    const replacementDir = path.join(tmp, "blob-replacement-cleanup-retry");
    const blobStore = new BlobStore(replacementDir);
    const expected = Buffer.from("expected-cleanup-retry-bytes");
    const hash = BlobStore.hash(expected);
    fs.mkdirSync(path.dirname(blobStore.pathFor(hash)), { recursive: true });
    fs.writeFileSync(blobStore.pathFor(hash), Buffer.alloc(expected.length, 0x78));

    const originalRemoveBackup = blobStore._removeBackup.bind(blobStore);
    let attempts = 0;
    blobStore._removeBackup = (backupPath) => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected backup cleanup failure");
      originalRemoveBackup(backupPath);
    };
    const replacement = blobStore.beginAtomicReplace(expected, hash);
    assert.equal(replacement.commitCleanup(), false);
    assert.equal(replacement.state, "cleanup_pending");
    assert.equal(fs.existsSync(replacement.backupPath), true);
    assert.equal(replacement.commitCleanup(), true);
    assert.equal(replacement.state, "committed");
    assert.equal(fs.existsSync(replacement.backupPath), false);
    assert.deepEqual(fs.readFileSync(blobStore.pathFor(hash)), expected);
  });

  check("asset lifecycle retries backup cleanup instead of ignoring a false result", () => {
    const blobPath = freshStore.blobs.pathFor(importedHash);
    fs.writeFileSync(blobPath, Buffer.alloc(importedBytes.length, 0x73));
    const originalRemoveBackup = freshStore.blobs._removeBackup.bind(freshStore.blobs);
    let attempts = 0;
    freshStore.blobs._removeBackup = (backupPath) => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected first cleanup failure");
      originalRemoveBackup(backupPath);
    };
    try {
      repository.importCharacter(importInput);
      assert.equal(attempts, 2);
      assert.deepEqual(fs.readFileSync(blobPath), importedBytes);
      assert.deepEqual(
        fs.readdirSync(path.dirname(blobPath)).filter((name) => name.includes(".backup-")),
        [],
      );
    } finally {
      freshStore.blobs._removeBackup = originalRemoveBackup;
    }
  });

  check("reconciliation removes a recoverable stale blob backup", () => {
    const blobPath = freshStore.blobs.pathFor(importedHash);
    const backupPath = `${blobPath}.backup-999-${"a".repeat(24)}`;
    fs.writeFileSync(backupPath, "obsolete-corrupt-backup");
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(backupPath, staleTime, staleTime);
    const result = repository.reconcileOrphanBlobs({ maxFiles: 100, graceMs: 0 });
    assert.equal(fs.existsSync(backupPath), false);
    assert(result.removedBackups >= 1);
  });

  check("failed import rolls back a verified blob repair and repair failures fail loud", () => {
    const blobPath = freshStore.blobs.pathFor(importedHash);
    const corrupt = Buffer.alloc(importedBytes.length, 0x79);
    const refcountBefore = freshStore.db.get(
      "SELECT refcount FROM blobs WHERE hash = ?",
      importedHash,
    ).refcount;
    fs.writeFileSync(blobPath, corrupt);
    assert.throws(
      () => repository.importCharacter({
        ...importInput,
        assertCanCommit() {
          assert.deepEqual(fs.readFileSync(blobPath), importedBytes);
          throw Object.assign(new Error("transaction aborted"), {
            code: "IMPORT_SERVICE_CLOSED",
          });
        },
      }),
      (error) => error.code === "IMPORT_SERVICE_CLOSED",
    );
    assert.deepEqual(fs.readFileSync(blobPath), corrupt);
    assert.equal(
      freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", importedHash).refcount,
      refcountBefore,
    );

    const originalReplace = freshStore.blobs.beginAtomicReplace;
    freshStore.blobs.beginAtomicReplace = () => {
      throw new Error("injected repair failure");
    };
    try {
      assert.throws(
        () => repository.importCharacter(importInput),
        (error) => error.code === "CHARACTER_BLOB_CORRUPT",
      );
    } finally {
      freshStore.blobs.beginAtomicReplace = originalReplace;
    }
    repository.importCharacter(importInput);
    assert.deepEqual(fs.readFileSync(blobPath), importedBytes);
    assert.equal(
      freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", importedHash).refcount,
      refcountBefore,
    );
  });

  check("exact duplicate recovery uses structured SQLite constraint metadata", () => {
    const originalGet = freshStore.db.get;
    const originalTransaction = freshStore.db.transaction;
    let hideExactOnce = true;
    freshStore.db.get = (sql, ...params) => {
      if (
        hideExactOnce
        && sql.includes("r.original_hash = ?")
        && params[0] === importOwner
        && params[1] === importedHash
      ) {
        hideExactOnce = false;
        return undefined;
      }
      return originalGet.call(freshStore.db, sql, ...params);
    };
    freshStore.db.transaction = (fn) => {
      const transaction = originalTransaction.call(freshStore.db, fn);
      return (...args) => {
        try {
          return transaction(...args);
        } catch (error) {
          if (Number(error?.errcode) === 2067) {
            throw Object.assign(new Error("唯一约束冲突"), {
              code: error.code,
              errcode: error.errcode,
            });
          }
          throw error;
        }
      };
    };
    try {
      const duplicate = repository.importCharacter({
        ...importInput,
        duplicateResolution: "create_copy",
      });
      assert.equal(duplicate.entity.id, importedFirst.entity.id);
      assert.equal(duplicate.revision.id, importedFirst.revision.id);
      assert.equal(duplicate.duplicate.reused, true);
    } finally {
      freshStore.db.get = originalGet;
      freshStore.db.transaction = originalTransaction;
    }
  });

  check("unconfirmed SQLite constraint errors are rethrown unchanged", () => {
    const unrelated = Object.assign(new Error("非唯一约束"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 787,
    });
    const originalTransaction = freshStore.db.transaction;
    freshStore.db.transaction = () => () => { throw unrelated; };
    try {
      assert.throws(
        () => repository.importCharacter({
          ...importInput,
          ownerScope: "profile:unrelated-constraint",
        }),
        (error) => error === unrelated,
      );
    } finally {
      freshStore.db.transaction = originalTransaction;
    }
  });

  check("canonical-only duplicate requires explicit create_copy resolution", () => {
    const variantBytes = Buffer.concat([importedBytes, Buffer.from("\n")]);
    const variantHash = crypto.createHash("sha256").update(variantBytes).digest("hex");
    const variantInput = {
      ...importInput,
      source: {
        ...importedSource,
        original: {
          ...importedSource.original,
          hash: variantHash,
          bytes: variantBytes.length,
        },
      },
      assets: [{
        purpose: "character-card-original",
        mime: "application/json",
        data: variantBytes,
      }],
    };
    assert.throws(
      () => repository.importCharacter(variantInput),
      (error) => error.code === "IMPORT_DUPLICATE_RESOLUTION_REQUIRED"
        && error.existingEntityId === importedFirst.entity.id,
    );
    const created = repository.importCharacter({
      ...variantInput,
      duplicateResolution: "create_copy",
    });
    assert.notEqual(created.entity.id, importedFirst.entity.id);
    assert.deepEqual(created.duplicate, {
      kind: "canonical",
      reused: false,
      resolution: "create_copy",
    });
    assert.equal(repository.listCharacters(importOwner).length, 2);
  });

  check("repository runs the lifecycle guard inside the final import transaction", () => {
    const guardedOwner = "profile:guarded-import";
    const guardedBytes = Buffer.from(
      '{"spec":"chara_card_v3","data":{"name":"Guarded Import"}}',
    );
    const guardedHash = crypto.createHash("sha256").update(guardedBytes).digest("hex");
    const catalogBefore = freshStore.db.get("SELECT COUNT(*) AS count FROM blobs").count;
    assert.throws(
      () => repository.importCharacter({
        ownerScope: guardedOwner,
        canonical: { schemaVersion: 1, name: "Guarded Import" },
        source: {
          kind: "imported",
          format: "v3_json",
          container: "json",
          original: {
            hash: guardedHash,
            bytes: guardedBytes.length,
            mime: "application/json",
            purpose: "character-card-original",
          },
        },
        assets: [{
          purpose: "character-card-original",
          mime: "application/json",
          data: guardedBytes,
        }],
        assertCanCommit() {
          throw Object.assign(new Error("service closed"), {
            code: "IMPORT_SERVICE_CLOSED",
          });
        },
      }),
      (error) => error.code === "IMPORT_SERVICE_CLOSED",
    );
    assert.equal(repository.listCharacters(guardedOwner).length, 0);
    assert.equal(
      freshStore.db.get("SELECT COUNT(*) AS count FROM blobs").count,
      catalogBefore,
    );
    assert.equal(freshStore.blobs.exists(guardedHash), false);
  });

  check("character creation atomically creates an immutable first revision", () => {
    assert.equal(first.entity.currentRevisionId, first.revision.id);
    assert.equal(first.entity.displayName, "Luna");
    assert.equal(first.entity.ownerScope, OWNER);
    assert.equal(first.revision.characterId, first.entity.id);
    assert.equal(first.revision.parentRevisionId, null);
    assert.equal(first.revision.revisionNumber, 1);
    assert.equal(first.revision.displayName, "Luna");
    assert.equal(first.revision.contentHash, expectedHash(lunaCanonical));
    assert.match(first.revision.revisionHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.revision.source, lunaSource);
    assert.deepEqual(repository.getRevision(OWNER, first.revision.id).canonical, lunaCanonical);
  });

  check("revision display names are bounded before persistence", () => {
    assert.throws(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "x".repeat(MAX_CHARACTER_TEXT_FIELD_BYTES + 1) },
      }),
      (error) => error.code === "CHARACTER_DATA_TOO_LARGE"
        && error.limit === MAX_CHARACTER_TEXT_FIELD_BYTES,
    );
  });

  check("source compatibility and provenance remain inside the source envelope bound", () => {
    assert.throws(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Oversized Source Report" },
        source: {
          kind: "imported",
          format: "v3_json",
          container: "json",
          compatibility: {
            ignoredInvalid: ["/data/description"],
            warnings: ["x".repeat(MAX_CHARACTER_SOURCE_BYTES)],
          },
          provenance: {
            schemaVersion: 1,
            importer: "lily_character_card_worker",
          },
        },
      }),
      (error) => error.code === "CHARACTER_DATA_TOO_LARGE"
        && error.limit === MAX_CHARACTER_SOURCE_BYTES,
    );
  });

  check("character source envelopes reject accessors and Proxies trap-free", () => {
    const entitiesBefore = repository.listCharacters(OWNER).length;
    let getterCalls = 0;
    const trappedSource = { kind: "imported", format: "v3_json", container: "json" };
    Object.defineProperty(trappedSource, "originalFileName", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "trap.json";
      },
    });
    assert.throws(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Trapped Character Source" },
        source: trappedSource,
      }),
      (error) => error.code === "CHARACTER_DATA_INVALID",
    );
    assert.equal(getterCalls, 0);
    assert.throws(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical: { schemaVersion: 1, name: "Proxied Character Source" },
        source: new Proxy({ kind: "imported", format: "v3_json", container: "json" }, {}),
      }),
      (error) => error.code === "CHARACTER_DATA_INVALID",
    );
    assert.equal(repository.listCharacters(OWNER).length, entitiesBefore);
  });

  check("asset admission bounds reject before blob or catalog writes", () => {
    const filesBefore = blobHashesOnDisk(freshBlobDir);
    const catalogBefore = freshStore.db.get("SELECT COUNT(*) AS count FROM blobs").count;
    const entitiesBefore = freshStore.db.get(
      "SELECT COUNT(*) AS count FROM character_entities",
    ).count;
    const canonical = { schemaVersion: 1, name: "Asset Limit Fixture" };
    const tiny = Buffer.from("tiny");

    assertAssetLimit(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical,
        assets: Array.from({ length: MAX_CHARACTER_ASSET_COUNT + 1 }, (_, index) => ({
          purpose: `asset-${index}`,
          mime: "application/octet-stream",
          data: tiny,
        })),
      }),
      "count",
      MAX_CHARACTER_ASSET_COUNT,
    );

    const oversizedItem = Buffer.allocUnsafe(MAX_CHARACTER_ASSET_BYTES + 1);
    assertAssetLimit(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical,
        assets: [{ purpose: "oversized", mime: "application/octet-stream", data: oversizedItem }],
      }),
      "perAssetBytes",
      MAX_CHARACTER_ASSET_BYTES,
    );

    const aggregateChunk = Buffer.allocUnsafe(MAX_CHARACTER_ASSET_BYTES);
    const aggregateCount = Math.floor(MAX_CHARACTER_ASSET_TOTAL_BYTES / aggregateChunk.byteLength) + 1;
    assertAssetLimit(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical,
        assets: Array.from({ length: aggregateCount }, (_, index) => ({
          purpose: `aggregate-${index}`,
          mime: "application/octet-stream",
          data: aggregateChunk,
        })),
      }),
      "aggregateBytes",
      MAX_CHARACTER_ASSET_TOTAL_BYTES,
    );

    assertAssetLimit(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical,
        assets: [{
          purpose: "p".repeat(MAX_CHARACTER_ASSET_PURPOSE_BYTES + 1),
          mime: "application/octet-stream",
          data: tiny,
        }],
      }),
      "purposeBytes",
      MAX_CHARACTER_ASSET_PURPOSE_BYTES,
    );

    assert.throws(
      () => repository.createCharacter({
        ownerScope: OWNER,
        canonical,
        assets: [{ purpose: "invalid", mime: "text/plain", data: "not-bytes" }],
      }),
      (error) => error.code === "CHARACTER_ASSET_INVALID"
        && error.limitsVersion === CHARACTER_ASSET_LIMITS_VERSION
        && error.index === 0
        && error.field === "data",
    );

    assert.deepEqual(blobHashesOnDisk(freshBlobDir), filesBefore);
    assert.equal(freshStore.db.get("SELECT COUNT(*) AS count FROM blobs").count, catalogBefore);
    assert.equal(
      freshStore.db.get("SELECT COUNT(*) AS count FROM character_entities").count,
      entitiesBefore,
    );
  });

  check("asset bytes are cataloged and linked to the revision", () => {
    const hash = crypto.createHash("sha256").update(avatarBytes).digest("hex");
    assert.equal(first.revision.cardAssets.length, 1);
    assert.deepEqual(first.revision.cardAssets[0], {
      hash,
      bytes: avatarBytes.length,
      mime: "image/png",
      purpose: "avatar",
    });
    assert.ok(freshStore.blobs.exists(hash));
    assert.deepEqual(
      { ...freshStore.db.get("SELECT hash, bytes, mime, refcount FROM blobs WHERE hash = ?", hash) },
      { hash, bytes: avatarBytes.length, mime: "image/png", refcount: 1 },
    );
    assert.deepEqual(
      { ...freshStore.db.get(
        "SELECT revision_id, hash, purpose FROM character_revision_blobs WHERE revision_id = ?",
        first.revision.id,
      ) },
      { revision_id: first.revision.id, hash, purpose: "avatar" },
    );
  });

  const mimeOwner = "profile:mime-test";
  const sharedMimeBytes = Buffer.from("same-bytes-different-mime");
  const mimeCanonical = { schemaVersion: 1, name: "MIME Fixture" };
  const mimeSource = { kind: "imported", format: "lily", container: "json" };
  const mimeFirst = repository.createCharacter({
    ownerScope: mimeOwner,
    canonical: mimeCanonical,
    source: mimeSource,
    assets: [{
      purpose: "avatar",
      mime: "image/png",
      data: sharedMimeBytes,
    }],
  });
  const mimeSecond = repository.createRevision({
    ownerScope: mimeOwner,
    entityId: mimeFirst.entity.id,
    baseRevisionId: mimeFirst.revision.id,
    canonical: { name: "MIME Fixture", schemaVersion: 1 },
    source: { ...mimeSource },
    assets: [{
      purpose: "avatar",
      mime: "application/octet-stream",
      data: sharedMimeBytes,
    }],
  });

  check("revision blob refs preserve MIME for identical global blob bytes", () => {
    const expectedBlobHash = crypto.createHash("sha256").update(sharedMimeBytes).digest("hex");
    assert.equal(mimeFirst.revision.cardAssets[0].hash, expectedBlobHash);
    assert.equal(mimeSecond.cardAssets[0].hash, expectedBlobHash);
    assert.equal(repository.getRevision(mimeOwner, mimeFirst.revision.id).cardAssets[0].mime, "image/png");
    assert.equal(repository.getRevision(mimeOwner, mimeSecond.id).cardAssets[0].mime, "application/octet-stream");
    assert.notEqual(mimeFirst.revision.revisionHash, mimeSecond.revisionHash);

    const duplicate = repository.createRevision({
      ownerScope: mimeOwner,
      entityId: mimeFirst.entity.id,
      baseRevisionId: mimeSecond.id,
      canonical: { schemaVersion: 1, name: "MIME Fixture" },
      source: { ...mimeSource },
      assets: [{
        purpose: "avatar",
        mime: "application/octet-stream",
        data: sharedMimeBytes,
      }],
    });
    assert.equal(duplicate.id, mimeSecond.id);
    assert.equal(duplicate.revisionHash, mimeSecond.revisionHash);
    assert.equal(
      freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", expectedBlobHash).refcount,
      2,
    );
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM character_revisions WHERE entity_id = ?",
        mimeFirst.entity.id,
      ).count,
      2,
    );
  });

  check("revision-reference MIME is bounded before persistence", () => {
    assertAssetLimit(
      () => repository.createCharacter({
        ownerScope: mimeOwner,
        canonical: { schemaVersion: 1, name: "Oversized MIME" },
        assets: [{
          purpose: "avatar",
          mime: "x".repeat(MAX_CHARACTER_ASSET_MIME_BYTES + 1),
          data: Buffer.from("oversized-mime"),
        }],
      }),
      "mimeBytes",
      MAX_CHARACTER_ASSET_MIME_BYTES,
    );
    assert.equal(repository.listCharacters(mimeOwner).length, 1);
  });

  check("identical full revision envelopes dedupe before writing blobs", () => {
    const deduped = repository.createRevision({
      ownerScope: OWNER,
      entityId: first.entity.id,
      baseRevisionId: first.revision.id,
      canonical: { description: "Navigator", name: "Luna", schemaVersion: 1 },
      source: { ...lunaSource },
      assets: [{ ...avatarAsset }],
    });
    assert.equal(deduped.id, first.revision.id);
    assert.equal(deduped.revisionHash, first.revision.revisionHash);
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM character_revisions WHERE entity_id = ?",
        first.entity.id,
      ).count,
      1,
    );
  });

  const changedSource = { ...lunaSource, originalFileName: "luna-copy.json" };
  const sourceRevision = repository.createRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: first.revision.id,
    canonical: { description: "Navigator", name: "Luna", schemaVersion: 1 },
    source: changedSource,
    assets: [{ ...avatarAsset }],
  });

  check("same canonical content with different source creates a revision", () => {
    assert.notEqual(sourceRevision.id, first.revision.id);
    assert.equal(sourceRevision.contentHash, first.revision.contentHash);
    assert.notEqual(sourceRevision.revisionHash, first.revision.revisionHash);
    assert.equal(sourceRevision.revisionNumber, 2);
    assert.deepEqual(sourceRevision.source, changedSource);
  });

  const alternateAvatarBytes = Buffer.from("different-local-avatar");
  const alternateAvatar = {
    purpose: "avatar",
    mime: "image/png",
    data: alternateAvatarBytes,
  };
  const assetRevision = repository.createRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: sourceRevision.id,
    canonical: { schemaVersion: 1, name: "Luna", description: "Navigator" },
    source: changedSource,
    assets: [alternateAvatar],
  });

  check("same canonical content with different assets creates a linked revision", () => {
    const alternateHash = crypto.createHash("sha256").update(alternateAvatarBytes).digest("hex");
    assert.notEqual(assetRevision.id, sourceRevision.id);
    assert.equal(assetRevision.contentHash, sourceRevision.contentHash);
    assert.notEqual(assetRevision.revisionHash, sourceRevision.revisionHash);
    assert.equal(assetRevision.revisionNumber, 3);
    assert.equal(assetRevision.cardAssets[0].hash, alternateHash);
    assert.ok(freshStore.blobs.exists(alternateHash));
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM character_revision_blobs WHERE revision_id = ?",
        assetRevision.id,
      ).count,
      1,
    );
  });

  check("full-envelope dedupe leaves no orphan blob files or catalog rows", () => {
    const deduped = repository.createRevision({
      ownerScope: OWNER,
      entityId: first.entity.id,
      baseRevisionId: assetRevision.id,
      canonical: { description: "Navigator", name: "Luna", schemaVersion: 1 },
      source: { ...changedSource },
      assets: [{ ...alternateAvatar }],
    });
    assert.equal(deduped.id, assetRevision.id);
    const catalogHashes = freshStore.db.all(
      "SELECT hash FROM blobs ORDER BY hash",
    ).map((row) => row.hash);
    const linkedHashes = freshStore.db.all(
      "SELECT DISTINCT hash FROM character_revision_blobs ORDER BY hash",
    ).map((row) => row.hash);
    assert.deepEqual(blobHashesOnDisk(freshBlobDir), catalogHashes);
    assert.deepEqual(catalogHashes, linkedHashes);
  });

  check("SQL rollback removes only files newly created by the failed operation", () => {
    const rollbackBytes = Buffer.from("rollback-only-character-asset");
    const rollbackHash = crypto.createHash("sha256").update(rollbackBytes).digest("hex");
    const sharedMessageBytes = Buffer.alloc(600 * 1024, 7);
    const sharedDataUrl = `data:application/octet-stream;base64,${sharedMessageBytes.toString("base64")}`;
    freshStore.append("shared-blob-session", {
      id: "shared_blob_message",
      role: "user",
      content: "shared blob fixture",
      record: { payload: sharedDataUrl },
    });
    const sharedRow = freshStore.db.get(
      "SELECT hash FROM message_blobs WHERE message_id = ?",
      "shared_blob_message",
    );
    assert.ok(sharedRow?.hash);
    const sharedRefcount = freshStore.db.get(
      "SELECT refcount FROM blobs WHERE hash = ?",
      sharedRow.hash,
    ).refcount;

    freshStore.db.exec(`
      CREATE TRIGGER test_character_asset_rollback
      BEFORE INSERT ON character_revision_blobs
      WHEN NEW.purpose = 'force-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced character asset rollback');
      END;
    `);
    try {
      assert.throws(
        () => repository.createCharacter({
          ownerScope: OWNER,
          canonical: { schemaVersion: 1, name: "Rollback New File" },
          assets: [{
            purpose: "force-rollback",
            mime: "application/octet-stream",
            data: rollbackBytes,
          }],
        }),
        /forced character asset rollback/,
      );
      assert.equal(freshStore.blobs.exists(rollbackHash), false);
      assert.equal(freshStore.db.get("SELECT 1 FROM blobs WHERE hash = ?", rollbackHash), undefined);

      assert.throws(
        () => repository.createCharacter({
          ownerScope: OWNER,
          canonical: { schemaVersion: 1, name: "Rollback Shared File" },
          assets: [{
            purpose: "force-rollback",
            mime: "application/octet-stream",
            data: sharedMessageBytes,
          }],
        }),
        /forced character asset rollback/,
      );
      assert.ok(freshStore.blobs.exists(sharedRow.hash));
      assert.equal(
        freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", sharedRow.hash).refcount,
        sharedRefcount,
      );
    } finally {
      freshStore.db.exec("DROP TRIGGER IF EXISTS test_character_asset_rollback;");
    }
  });

  check("bounded reconciliation removes stale crash orphans only", () => {
    const staleBytes = Buffer.from("stale-crash-orphan");
    const staleRef = freshStore.blobs.write(staleBytes);
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(freshStore.blobs.pathFor(staleRef.hash), staleTime, staleTime);

    const unknownDir = path.join(freshBlobDir, "unknown");
    const unknownFile = path.join(unknownDir, "do-not-touch.tmp");
    fs.mkdirSync(unknownDir, { recursive: true });
    fs.writeFileSync(unknownFile, "unknown");

    const sharedMessageHash = freshStore.db.get(
      "SELECT hash FROM message_blobs WHERE message_id = ?",
      "shared_blob_message",
    ).hash;
    const sharedRefcount = freshStore.db.get(
      "SELECT refcount FROM blobs WHERE hash = ?",
      sharedMessageHash,
    ).refcount;
    const result = repository.reconcileOrphanBlobs({ maxFiles: 100, graceMs: 60_000 });

    assert.equal(result.removed, 1);
    assert.deepEqual(result.removedHashes, [staleRef.hash]);
    assert.equal(freshStore.blobs.exists(staleRef.hash), false);
    assert.ok(freshStore.blobs.exists(sharedMessageHash));
    assert.equal(
      freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", sharedMessageHash).refcount,
      sharedRefcount,
    );
    assert.ok(fs.existsSync(unknownFile));
    assert.ok(result.scanned <= 100);
  });

  const second = repository.createRevision({
    ownerScope: OWNER,
    entityId: first.entity.id,
    baseRevisionId: assetRevision.id,
    canonical: { schemaVersion: 1, name: "Luna Prime", description: "Navigator" },
    source: { kind: "edited", format: "lily", container: "json" },
  });

  check("revision edits append rows and move only the entity pointer", () => {
    assert.notEqual(second.id, first.revision.id);
    assert.equal(second.parentRevisionId, assetRevision.id);
    assert.equal(second.revisionNumber, 4);
    assert.equal(second.displayName, "Luna Prime");
    assert.equal(repository.getCharacter(OWNER, first.entity.id).currentRevisionId, second.id);
    assert.equal(repository.getCharacter(OWNER, first.entity.id).displayName, "Luna Prime");
    assert.equal(repository.getRevision(OWNER, first.revision.id).displayName, "Luna");
    assert.equal(repository.getRevision(OWNER, first.revision.id).canonical.name, "Luna");
    assert.equal(repository.getRevision(OWNER, second.id).canonical.name, "Luna Prime");
  });

  check("a stale base revision fails without replacing current", () => {
    assert.throws(
      () => repository.createRevision({
        ownerScope: OWNER,
        entityId: first.entity.id,
        baseRevisionId: first.revision.id,
        canonical: { schemaVersion: 1, name: "Stale edit" },
      }),
      (error) => error.code === "CHARACTER_REVISION_CONFLICT"
        && error.currentRevisionId === second.id,
    );
    assert.equal(repository.getCharacter(OWNER, first.entity.id).currentRevisionId, second.id);
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM character_revisions WHERE entity_id = ?",
        first.entity.id,
      ).count,
      4,
    );
  });

  check("all character reads use exact owner-scope isolation", () => {
    assert.deepEqual(repository.listCharacters(OTHER_OWNER), []);
    assert.equal(repository.getCharacter(OTHER_OWNER, first.entity.id), null);
    assert.equal(repository.getRevision(OTHER_OWNER, second.id), null);
    assert.equal(repository.archiveCharacter(OTHER_OWNER, first.entity.id), null);
    assert.equal(repository.getCharacter(OWNER, first.entity.id).archivedAt, null);
  });

  check("owner-safe foreign keys reject dangling and cross-owner raw writes", () => {
    const badEntityId = crypto.randomUUID();
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_entities
           (id, owner_scope, display_name, current_revision_id, archived_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        badEntityId, OTHER_OWNER, "Cross owner", first.revision.id, Date.now(), Date.now(),
      ),
      /FOREIGN KEY constraint failed/,
    );

    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_revisions
           (id, entity_id, owner_scope, parent_revision_id, revision_number,
            display_name, source_kind, source_format, source_container,
            canonical_json, source_json, canonical_hash, revision_hash, created_at)
         SELECT ?, entity_id, ?, NULL, 99, display_name, source_kind,
                source_format, source_container, canonical_json, source_json,
                canonical_hash, ?, ?
         FROM character_revisions WHERE id = ?`,
        crypto.randomUUID(), OTHER_OWNER, `sha256:${"a".repeat(64)}`,
        Date.now(), first.revision.id,
      ),
      /FOREIGN KEY constraint failed/,
    );

    const constraintOwner = "profile:constraint-test";
    const constraintCharacter = repository.createCharacter({
      ownerScope: constraintOwner,
      canonical: { schemaVersion: 1, name: "Constraint Fixture" },
      source: { kind: "created", format: "lily", container: "json" },
    });
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_revisions
           (id, entity_id, owner_scope, parent_revision_id, revision_number,
            display_name, source_kind, source_format, source_container,
            canonical_json, source_json, canonical_hash, revision_hash, created_at)
         SELECT ?, ?, ?, ?, 2, display_name, source_kind, source_format,
                source_container, canonical_json, source_json, canonical_hash, ?, ?
         FROM character_revisions WHERE id = ?`,
        crypto.randomUUID(), constraintCharacter.entity.id, constraintOwner,
        first.revision.id, `sha256:${"b".repeat(64)}`, Date.now(), first.revision.id,
      ),
      /FOREIGN KEY constraint failed/,
    );

    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_revisions
           (id, entity_id, owner_scope, parent_revision_id, revision_number,
            display_name, source_kind, source_format, source_container,
            canonical_json, source_json, canonical_hash, revision_hash, created_at)
         SELECT ?, entity_id, owner_scope, NULL, revision_number, display_name,
                source_kind, source_format, source_container, canonical_json,
                source_json, canonical_hash, ?, ?
         FROM character_revisions WHERE id = ?`,
        crypto.randomUUID(), `sha256:${"c".repeat(64)}`, Date.now(), first.revision.id,
      ),
      /UNIQUE constraint failed: character_revisions.entity_id, character_revisions.revision_number/,
    );

    const avatarHash = first.revision.cardAssets[0].hash;
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose)
         VALUES (?, ?, ?, ?, ?, ?)`,
        first.revision.id, OWNER, "missing-blob", 1, null, "invalid",
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_revision_blobs
           (revision_id, owner_scope, hash, bytes, mime, purpose)
         VALUES (?, ?, ?, ?, ?, ?)`,
        first.revision.id, OTHER_OWNER, avatarHash,
        avatarBytes.length, "image/png", "invalid-owner",
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => freshStore.db.run(
        `INSERT INTO character_session_bindings
           (session_id, owner_scope, binding_version, mode,
            character_revision_id, compatibility_profile, binding_json, updated_at)
         VALUES (?, ?, 1, 'character', ?, ?, '{}', ?)`,
        "cross-owner-session", OTHER_OWNER, first.revision.id,
        CHARACTER_COMPATIBILITY_PROFILE, Date.now(),
      ),
      /FOREIGN KEY constraint failed/,
    );
  });

  const forwardRevisionFixtures = [];
  check("forward revision tables enforce circular ownership and revision numbers", () => {
    for (const prefix of ["persona", "world_book"]) {
      const entityId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      // v8 gave world_book_revisions a revision_hash column (default '') and
      // v11 did the same for persona_revisions; the raw fixtures must set
      // distinct hashes so the intended revision-number constraint — not the
      // duplicate-revision hash index — is exercised.
      const hashColumn = ", revision_hash";
      const fixtureHash = `, 'sha256:${"1".repeat(64)}'`;
      const duplicateHash = `, 'sha256:${"2".repeat(64)}'`;
      freshStore.db.transaction(() => {
        freshStore.db.run(
          `INSERT INTO ${prefix}_entities
             (id, owner_scope, display_name, current_revision_id, archived_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          entityId, OWNER, `${prefix} fixture`, revisionId, Date.now(), Date.now(),
        );
        freshStore.db.run(
          `INSERT INTO ${prefix}_revisions
             (id, entity_id, owner_scope, parent_revision_id, revision_number,
              canonical_json, canonical_hash, created_at${hashColumn})
           VALUES (?, ?, ?, NULL, 1, '{}', ?, ?${fixtureHash})`,
          revisionId, entityId, OWNER, `sha256:${"d".repeat(64)}`, Date.now(),
        );
      })();
      forwardRevisionFixtures.push({ prefix, entityId, revisionId });

      assert.throws(
        () => freshStore.db.run(
          `INSERT INTO ${prefix}_revisions
             (id, entity_id, owner_scope, parent_revision_id, revision_number,
              canonical_json, canonical_hash, created_at${hashColumn})
           VALUES (?, ?, ?, NULL, 1, '{}', ?, ?${duplicateHash})`,
          crypto.randomUUID(), entityId, OWNER, `sha256:${"e".repeat(64)}`, Date.now(),
        ),
        new RegExp(`UNIQUE constraint failed: ${prefix}_revisions.entity_id, ${prefix}_revisions.revision_number`),
      );
      assert.throws(
        () => freshStore.db.run(
          `INSERT INTO ${prefix}_entities
             (id, owner_scope, display_name, current_revision_id, archived_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          crypto.randomUUID(), OWNER, "Invalid pointer", revisionId, Date.now(), Date.now(),
        ),
        /FOREIGN KEY constraint failed/,
      );
    }
    assert.deepEqual(freshStore.db.all("PRAGMA foreign_key_check"), []);
  });

  check("existing sessions are native without eager binding rows", () => {
    assert.deepEqual(repository.getBinding("session-a", OWNER), EXPECTED_NATIVE("session-a"));
    assert.equal(
      freshStore.db.get("SELECT COUNT(*) AS count FROM character_session_bindings").count,
      0,
    );
  });

  const characterBinding = repository.setBinding({
    sessionId: "session-a",
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: second.id,
      compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
    },
  });

  check("binding CAS persists a versioned forward-compatible envelope", () => {
    assert.deepEqual(characterBinding, {
      schemaVersion: 1,
      sessionId: "session-a",
      mode: "character",
      bindingVersion: 1,
      characterRevisionId: second.id,
      personaRevisionId: null,
      compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
      greetingIndex: null,
    });
    const row = freshStore.db.get(
      "SELECT binding_json FROM character_session_bindings WHERE session_id = ?",
      "session-a",
    );
    assert.ok(Buffer.byteLength(row.binding_json, "utf8") <= MAX_CHARACTER_BINDING_BYTES);
    const envelope = JSON.parse(row.binding_json);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.bindingVersion, 1);
    assert.equal(envelope.activeCharacterRevisionId, second.id);
    assert.equal(envelope.activePersonaRevisionId, null);
    assert.deepEqual(envelope.worldBookBindings, []);
    assert.equal(envelope.groupSceneId, null);
  });

  check("binding CAS conflict attaches current binding and never mutates", () => {
    assert.throws(
      () => repository.setBinding({
        sessionId: "session-a",
        ownerScope: OWNER,
        expectedBindingVersion: 0,
        next: { mode: "native" },
      }),
      (error) => error.code === "CHARACTER_BINDING_CONFLICT"
        && error.current?.bindingVersion === 1
        && error.current?.characterRevisionId === second.id,
    );
    assert.deepEqual(repository.getBinding("session-a", OWNER), characterBinding);
    assert.equal(repository.getBindingEvents("session-a", OWNER).length, 1);
  });

  const nativeBinding = repository.setBinding({
    sessionId: "session-a",
    ownerScope: OWNER,
    expectedBindingVersion: 1,
    next: { mode: "native" },
  });

  check("binding events are append-only and returned in commit order", () => {
    assert.deepEqual(nativeBinding, {
      ...EXPECTED_NATIVE("session-a"),
      bindingVersion: 2,
    });
    const events = repository.getBindingEvents("session-a", OWNER);
    assert.deepEqual(events.map((event) => event.bindingVersion), [1, 2]);
    assert.deepEqual(events.map((event) => event.nextBinding.mode), ["character", "native"]);
    assert.equal(events[1].previousBinding.activeCharacterRevisionId, second.id);
    assert.equal(events[0].nextBinding.compatibilityProfileVersion, 1);
    assert.equal(events[0].nextBinding.activePersonaRevisionId, null);
    assert.deepEqual(events[0].nextBinding.worldBookBindings, []);
    assert.equal(events[0].nextBinding.groupSceneId, null);
    assert.equal(
      freshStore.db.get(
        "SELECT COUNT(*) AS count FROM character_binding_events WHERE session_id = ?",
        "session-a",
      ).count,
      2,
    );
  });

  const futurePreviousBinding = {
    schemaVersion: 2,
    bindingVersion: 2,
    compatibilityProfileVersion: 7,
    compatibilityProfile: "future-profile-v7",
    mode: "story",
    activeCharacterRevisionId: second.id,
    activePersonaRevisionId: "persona-revision-future",
    activeGreetingIndex: 3,
    worldBookBindings: [{
      revisionId: "world-revision-future",
      scope: "persona",
      futureWeight: 0.75,
    }],
    worldResolutionPolicy: { sourceMergeStrategy: "global_first", futurePolicy: true },
    groupSceneId: "group-scene-future",
    effectiveAfterTurnId: "turn-before-future",
    updatedAt: "2026-07-30T00:00:00.000Z",
    unknownFutureField: { nested: ["preserve", 1] },
  };
  const futureNextBinding = {
    ...futurePreviousBinding,
    bindingVersion: 3,
    activeGreetingIndex: 4,
    effectiveAfterTurnId: "turn-future",
    unknownFutureField: { nested: ["preserve", 2] },
  };
  const futureEvent = {
    schemaVersion: 2,
    id: "future_binding_event",
    sessionId: "session-a",
    type: "character_binding.changed",
    previousBinding: futurePreviousBinding,
    nextBinding: futureNextBinding,
    effectiveAfterTurnId: "turn-future",
    createdAt: "2026-07-30T00:01:00.000Z",
    unknownEventField: { keep: true },
  };
  freshStore.db.run(
    `INSERT INTO character_binding_events
       (id, session_id, owner_scope, binding_version, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    futureEvent.id,
    "session-a",
    OWNER,
    3,
    JSON.stringify(futureEvent),
    Date.parse(futureEvent.createdAt),
  );

  check("binding event reads preserve complete persisted future envelopes", () => {
    const event = repository.getBindingEvents("session-a", OWNER)
      .find((candidate) => candidate.id === futureEvent.id);
    assert.equal(event.bindingVersion, 3);
    assert.deepEqual(event.previousBinding, futurePreviousBinding);
    assert.deepEqual(event.nextBinding, futureNextBinding);
    assert.equal(event.effectiveAfterTurnId, "turn-future");
    assert.deepEqual(event.unknownEventField, { keep: true });
  });

  check("SQLite rejects revision, asset-link, and binding-event mutation", () => {
    const revisionBefore = { ...freshStore.db.get(
      `SELECT canonical_hash, revision_hash, display_name
       FROM character_revisions WHERE id = ?`,
      first.revision.id,
    ) };
    const assetBefore = { ...freshStore.db.get(
      `SELECT hash, bytes, mime, purpose
       FROM character_revision_blobs WHERE revision_id = ?`,
      first.revision.id,
    ) };
    const blobRefcountBefore = freshStore.db.get(
      "SELECT refcount FROM blobs WHERE hash = ?",
      assetBefore.hash,
    ).refcount;
    const eventRowsBefore = freshStore.db.all(
      `SELECT id, event_json FROM character_binding_events
       WHERE session_id = ? ORDER BY binding_version`,
      "session-a",
    ).map((row) => ({ ...row }));

    assert.throws(
      () => freshStore.db.run(
        "UPDATE character_revisions SET canonical_hash = ? WHERE id = ?",
        `sha256:${"f".repeat(64)}`,
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run("DELETE FROM character_revisions WHERE id = ?", first.revision.id),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "UPDATE character_revision_blobs SET mime = ? WHERE revision_id = ?",
        "text/plain",
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "DELETE FROM character_revision_blobs WHERE revision_id = ?",
        first.revision.id,
      ),
      /immutable/,
    );
    assert.throws(
      () => freshStore.db.run(
        "UPDATE character_binding_events SET event_json = '{}' WHERE id = ?",
        futureEvent.id,
      ),
      /append-only/,
    );
    assert.throws(
      () => freshStore.db.run("DELETE FROM character_binding_events WHERE id = ?", futureEvent.id),
      /append-only/,
    );

    for (const { prefix, revisionId } of forwardRevisionFixtures) {
      assert.throws(
        () => freshStore.db.run(
          `UPDATE ${prefix}_revisions SET canonical_hash = ? WHERE id = ?`,
          `sha256:${"f".repeat(64)}`,
          revisionId,
        ),
        /immutable/,
      );
      assert.throws(
        () => freshStore.db.run(
          `DELETE FROM ${prefix}_revisions WHERE id = ?`,
          revisionId,
        ),
        /immutable/,
      );
    }

    assert.deepEqual(
      { ...freshStore.db.get(
        `SELECT canonical_hash, revision_hash, display_name
         FROM character_revisions WHERE id = ?`,
        first.revision.id,
      ) },
      revisionBefore,
    );
    assert.deepEqual(
      { ...freshStore.db.get(
        `SELECT hash, bytes, mime, purpose
         FROM character_revision_blobs WHERE revision_id = ?`,
        first.revision.id,
      ) },
      assetBefore,
    );
    assert.equal(
      freshStore.db.get("SELECT refcount FROM blobs WHERE hash = ?", assetBefore.hash).refcount,
      blobRefcountBefore,
    );
    assert.deepEqual(
      freshStore.db.all(
        `SELECT id, event_json FROM character_binding_events
         WHERE session_id = ? ORDER BY binding_version`,
        "session-a",
      ).map((row) => ({ ...row })),
      eventRowsBefore,
    );
  });

  check("binding reads and events do not cross exact owner scopes", () => {
    assert.deepEqual(repository.getBinding("session-a", OTHER_OWNER), EXPECTED_NATIVE("session-a"));
    assert.deepEqual(repository.getBindingEvents("session-a", OTHER_OWNER), []);
    assert.throws(
      () => repository.setBinding({
        sessionId: "session-a",
        ownerScope: OTHER_OWNER,
        expectedBindingVersion: 0,
        next: { mode: "native" },
      }),
      (error) => error.code === "CHARACTER_BINDING_OWNER_MISMATCH",
    );
    assert.equal(repository.getBinding("session-a", OWNER).bindingVersion, 2);
  });

  check("archive hides an entity from default lists without deleting revisions", () => {
    const archived = repository.archiveCharacter(OWNER, first.entity.id);
    assert.ok(archived.archivedAt);
    assert.deepEqual(repository.listCharacters(OWNER), []);
    assert.equal(repository.listCharacters(OWNER, { includeArchived: true }).length, 1);
    assert.equal(repository.getRevision(OWNER, second.id).canonical.name, "Luna Prime");
  });

  freshStore.close();
  freshStore = null;
  reopenedStore = new MessageStore(freshDbPath, freshBlobDir);
  const reopened = reopenedStore.characterWorlds();

  check("entities, revisions, assets, bindings, and events survive reopen", () => {
    assert.equal(reopened.getCharacter(OWNER, first.entity.id).currentRevisionId, second.id);
    assert.equal(reopened.getRevision(OWNER, second.id).revisionNumber, 4);
    assert.equal(reopened.getRevision(OWNER, second.id).displayName, "Luna Prime");
    assert.equal(reopened.getRevision(OWNER, first.revision.id).displayName, "Luna");
    assert.equal(reopened.getRevision(OWNER, first.revision.id).cardAssets.length, 1);
    assert.equal(reopened.getRevision(mimeOwner, mimeFirst.revision.id).cardAssets[0].mime, "image/png");
    assert.equal(reopened.getRevision(mimeOwner, mimeSecond.id).cardAssets[0].mime, "application/octet-stream");
    assert.equal(reopened.getBinding("session-a", OWNER).bindingVersion, 2);
    assert.deepEqual(
      reopened.getBindingEvents("session-a", OWNER).map((event) => event.bindingVersion),
      [1, 2, 3],
    );
    const reopenedFutureEvent = reopened.getBindingEvents("session-a", OWNER)
      .find((event) => event.id === futureEvent.id);
    assert.deepEqual(reopenedFutureEvent.previousBinding, futurePreviousBinding);
    assert.deepEqual(reopenedFutureEvent.nextBinding, futureNextBinding);
  });

  console.log(`\ncharacter-worlds-store: ${checks} checks passed`);
} finally {
  freshStore?.close();
  reopenedStore?.close();
  migratedStore?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
