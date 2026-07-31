#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");
const {
  ownerScopeFromPrincipal,
  scopeHash,
} = require("../src/main/character-worlds/owner-scope.js");
const {
  createQueueRecoveryEnvelope,
} = require("../src/main/turn-queue-recovery-envelope.js");
const {
  QUARANTINE_EXTERNAL_SQL,
  QUARANTINE_SCHEDULED_SQL,
} = require("../src/main/store/turn-admission-store.js");
const {
  MAX_MIGRATION_METADATA_BYTES,
  MIGRATION_METADATA_SCHEMA_VERSION,
  parseMigrationMetadata,
} = require("../src/main/store/turn-admission-migration-metadata.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-admission-migration-"));
const dbPath = path.join(root, "messages.db");
const blobDir = path.join(root, "blobs");
const scheduledDbPath = path.join(root, "scheduled-tasks.db");
const ownerA = scopeHash("account", "migration-owner-a");
const ownerB = scopeHash("account", "migration-owner-b");
const revisionA = "revision-migration-owner-a";
const entityA = "entity-migration-owner-a";

function readyMetadata() {
  return {
    characterWorlds: {
      schemaVersion: 1,
      mode: "character",
      bindingVersion: 7,
      characterRevisionId: revisionA,
      compatibilityProfile: "sillytavern-character-v1",
      snapshotStatus: "ready",
    },
  };
}

function queueMetadata({
  queueItemId,
  scheduledTaskRunId = null,
  externalCommand = null,
  characterWorlds = null,
}) {
  return {
    ...(characterWorlds ? { characterWorlds } : {}),
    queueRecovery: {
      schemaVersion: 1,
      kind: "durable_queue",
      queueItemId,
      displayFiles: [],
      options: {
        ...(scheduledTaskRunId ? { scheduledTaskRunId } : {}),
        ...(externalCommand ? { externalCommand } : {}),
      },
    },
  };
}

function insertLegacyTurn(db, {
  sessionId,
  seq,
  turnId,
  delivery = "direct",
  metadata = {},
  metadataText = null,
}) {
  db.run(
    `INSERT INTO turn_inputs
       (session_id, admitted_seq, turn_id, delivery, status, user_text,
        files_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'admitted', ?, '[]', ?, ?)`,
    sessionId,
    seq,
    turnId,
    delivery,
    turnId,
    metadataText ?? JSON.stringify(metadata),
    1000 + seq,
  );
}

function metadataWithExactBytes(base, targetBytes) {
  const empty = JSON.stringify({ ...base, legacyPadding: "" });
  const paddingBytes = targetBytes - Buffer.byteLength(empty, "utf8");
  assert.ok(paddingBytes >= 0);
  const result = JSON.stringify({
    ...base,
    legacyPadding: "x".repeat(paddingBytes),
  });
  assert.equal(Buffer.byteLength(result, "utf8"), targetBytes);
  return result;
}

let store;
try {
  assert.equal(typeof QUARANTINE_SCHEDULED_SQL, "string");
  assert.equal(typeof QUARANTINE_EXTERNAL_SQL, "string");
  assert.equal(MIGRATION_METADATA_SCHEMA_VERSION, 1);
  assert.ok(MAX_MIGRATION_METADATA_BYTES >= 1024 * 1024);
  assert.equal(
    parseMigrationMetadata(JSON.stringify({ __protoProbe: "safe" })).status,
    "ok",
  );
  assert.equal(
    parseMigrationMetadata('{"__proto__":"unsafe"}').status,
    "metadata_invalid",
  );
  assert.equal(
    parseMigrationMetadata(JSON.stringify({ value: "\ud800" })).status,
    "metadata_invalid",
  );
  assert.equal(
    parseMigrationMetadata(JSON.stringify({
      value: "x".repeat(1024 * 1024 + 1),
    })).status,
    "metadata_invalid",
  );
  let tooDeep = {};
  let depthCursor = tooDeep;
  for (let depth = 0; depth < 13; depth += 1) {
    depthCursor.child = {};
    depthCursor = depthCursor.child;
  }
  assert.equal(
    parseMigrationMetadata(JSON.stringify(tooDeep)).status,
    "metadata_invalid",
  );
  assert.equal(
    parseMigrationMetadata(JSON.stringify({
      values: Array.from({ length: 9000 }, () => 0),
    })).status,
    "metadata_invalid",
  );
  assert.equal(
    typeof ownerScopeFromPrincipal,
    "function",
    "scheduled migration needs one shared principal-to-owner-scope mapper",
  );
  assert.equal(ownerScopeFromPrincipal("user:migration-owner-a"), ownerA);
  assert.equal(
    ownerScopeFromPrincipal("device:migration-device"),
    scopeHash("device", "migration-device"),
  );
  assert.equal(ownerScopeFromPrincipal("unknown:migration-owner-a"), null);

  const db = openDatabase(dbPath);
  db.migrate(MIGRATIONS.slice(0, 5));
  db.transaction(() => {
    db.run(
      `INSERT INTO character_entities
         (id, owner_scope, display_name, current_revision_id, archived_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      entityA,
      ownerA,
      "Migration owner A",
      revisionA,
      1000,
      1000,
    );
    db.run(
      `INSERT INTO character_revisions
         (id, entity_id, owner_scope, parent_revision_id, revision_number,
          display_name, source_kind, source_format, source_container,
          canonical_json, source_json, canonical_hash, revision_hash, created_at)
       VALUES (?, ?, ?, NULL, 1, ?, 'import', 'json', 'json',
               '{}', '{}', ?, ?, ?)`,
      revisionA,
      entityA,
      ownerA,
      "Migration owner A",
      `sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      1000,
    );
  })();

  insertLegacyTurn(db, {
    sessionId: "legacy-character-session",
    seq: 1,
    turnId: "legacy-character-turn",
    metadata: readyMetadata(),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-unknown-session",
    seq: 1,
    turnId: "legacy-unknown-turn",
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-scheduled-session",
    seq: 1,
    turnId: "legacy-scheduled-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-scheduled-item",
      scheduledTaskRunId: "legacy-scheduled-run",
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-scheduled-session",
    seq: 2,
    turnId: "legacy-scheduled-duplicate-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-scheduled-duplicate-item",
      scheduledTaskRunId: "legacy-scheduled-run",
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-conflict-session",
    seq: 1,
    turnId: "legacy-conflict-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-conflict-item",
      scheduledTaskRunId: "legacy-conflict-run",
      characterWorlds: readyMetadata().characterWorlds,
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-missing-run-session",
    seq: 1,
    turnId: "legacy-missing-run-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-missing-run-item",
      scheduledTaskRunId: "legacy-missing-run",
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-external-session",
    seq: 1,
    turnId: "legacy-external-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-external-item",
      externalCommand: {
        commandId: "legacy-external-command",
        idempotencyKey: "legacy-external-key",
        payloadHash: "legacy-external-hash",
        desktopDeviceId: "legacy-external-desktop",
        mobileDeviceId: "legacy-external-mobile",
      },
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-external-owned-session",
    seq: 1,
    turnId: "legacy-external-owned-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-external-owned-item",
      characterWorlds: readyMetadata().characterWorlds,
      externalCommand: {
        commandId: "legacy-external-owned-command",
        idempotencyKey: "legacy-external-owned-key",
        payloadHash: "legacy-external-owned-hash",
        desktopDeviceId: "legacy-external-owned-desktop",
        mobileDeviceId: "legacy-external-owned-mobile",
      },
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-external-owned-duplicate-session",
    seq: 1,
    turnId: "legacy-external-owned-duplicate-turn",
    delivery: "queue",
    metadata: queueMetadata({
      queueItemId: "legacy-external-owned-duplicate-item",
      characterWorlds: readyMetadata().characterWorlds,
      externalCommand: {
        commandId: "legacy-external-owned-duplicate-command",
        idempotencyKey: "legacy-external-owned-key",
        payloadHash: "legacy-external-owned-hash",
        desktopDeviceId: "legacy-external-owned-desktop",
        mobileDeviceId: "legacy-external-owned-mobile",
      },
    }),
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-top-level-session",
    seq: 1,
    turnId: "legacy-top-level-turn",
    delivery: "queue",
    metadata: {
      scheduledTaskId: "legacy-top-level-task",
      scheduledTaskRunId: "legacy-top-level-run",
    },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-v2-envelope-session",
    seq: 1,
    turnId: "legacy-v2-envelope-turn",
    delivery: "queue",
    metadata: {
      queueRecovery: {
        schemaVersion: 2,
        kind: "durable_queue",
        queueItemId: "legacy-v2-envelope-item",
        fileRefs: [],
        options: {
          scheduledTaskId: "legacy-v2-envelope-task",
          scheduledTaskRunId: "legacy-v2-envelope-run",
        },
      },
    },
  });
  const largeOwnedMetadata = metadataWithExactBytes({
    scheduledTaskId: "legacy-large-owned-task",
    scheduledTaskRunId: "legacy-large-owned-run",
  }, 71_928);
  insertLegacyTurn(db, {
    sessionId: "legacy-large-owned-session",
    seq: 1,
    turnId: "legacy-large-owned-turn",
    delivery: "queue",
    metadataText: largeOwnedMetadata,
  });
  const largeAmbiguousMetadata = metadataWithExactBytes({
    scheduledTaskId: "legacy-large-ambiguous-task",
    scheduledTaskRunId: "legacy-large-ambiguous-run",
  }, 71_928);
  insertLegacyTurn(db, {
    sessionId: "legacy-large-ambiguous-session",
    seq: 1,
    turnId: "legacy-large-ambiguous-turn",
    delivery: "queue",
    metadataText: largeAmbiguousMetadata,
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-db-turn-session",
    seq: 1,
    turnId: "legacy-db-turn-corrupt-metadata",
    delivery: "queue",
    metadataText: "{",
  });
  const overCapMetadata = JSON.stringify({
    legacyPadding: "x".repeat(MAX_MIGRATION_METADATA_BYTES),
  });
  assert.ok(
    Buffer.byteLength(overCapMetadata, "utf8")
      > MAX_MIGRATION_METADATA_BYTES,
  );
  insertLegacyTurn(db, {
    sessionId: "legacy-db-turn-overcap-session",
    seq: 1,
    turnId: "legacy-db-turn-overcap-metadata",
    delivery: "queue",
    metadataText: overCapMetadata,
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-db-owner-unknown-session",
    seq: 1,
    turnId: "legacy-db-owner-unknown-turn",
    delivery: "queue",
    metadataText: "{",
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-db-priority-session",
    seq: 1,
    turnId: "legacy-db-priority-turn",
    delivery: "queue",
    metadata: {
      scheduledTaskRunId: "legacy-stale-run-not-in-db",
      scheduledTaskId: "legacy-db-priority-task",
    },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-db-conflict-session",
    seq: 1,
    turnId: "legacy-db-conflict-turn",
    delivery: "queue",
    metadata: {
      scheduledTaskRunId: "legacy-db-conflict-metadata-run",
      scheduledTaskId: "legacy-db-conflict-task",
    },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-db-mismatch-session",
    seq: 1,
    turnId: "legacy-db-mismatch-turn",
    delivery: "queue",
    metadata: {
      scheduledTaskRunId: "legacy-db-mismatch-run",
      scheduledTaskId: "legacy-db-mismatch-task",
    },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-task-hint-session",
    seq: 1,
    turnId: "legacy-task-hint-turn",
    delivery: "queue",
    metadata: { scheduledTaskId: "legacy-task-hint-only" },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-identity-conflict-session",
    seq: 1,
    turnId: "legacy-identity-conflict-turn",
    delivery: "queue",
    metadata: {
      scheduledTaskRunId: "legacy-identity-conflict-top-level",
      ...queueMetadata({
        queueItemId: "legacy-identity-conflict-item",
        scheduledTaskRunId: "legacy-identity-conflict-envelope",
      }),
    },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-corrupt-ordinary-session",
    seq: 1,
    turnId: "legacy-corrupt-ordinary-turn",
    delivery: "queue",
    metadataText: "{",
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-external-top-session",
    seq: 1,
    turnId: "legacy-external-top-turn",
    delivery: "queue",
    metadata: {
      externalCommandId: "legacy-external-top-command",
      commandId: "legacy-external-top-command",
    },
  });
  insertLegacyTurn(db, {
    sessionId: "legacy-command-alias-session",
    seq: 1,
    turnId: "legacy-command-alias-turn",
    delivery: "queue",
    metadata: { commandId: "legacy-command-alias" },
  });

  const scheduled = openDatabase(scheduledDbPath);
  scheduled.exec(`
    CREATE TABLE scheduled_task_runs (
      id TEXT PRIMARY KEY,
      owner_principal TEXT NOT NULL,
      execution_session_id TEXT NOT NULL,
      turn_id TEXT
    );
  `);
  const insertScheduledRun = (
    id,
    ownerPrincipal,
    executionSessionId,
    turnId = null,
  ) => scheduled.run(
    `INSERT INTO scheduled_task_runs
       (id, owner_principal, execution_session_id, turn_id)
     VALUES (?, ?, ?, ?)`,
    id,
    ownerPrincipal,
    executionSessionId,
    turnId,
  );
  insertScheduledRun(
    "legacy-scheduled-run",
    "user:migration-owner-a",
    "legacy-scheduled-session",
    "legacy-scheduled-turn",
  );
  insertScheduledRun(
    "legacy-conflict-run",
    "user:migration-owner-b",
    "legacy-conflict-session",
    "legacy-conflict-turn",
  );
  insertScheduledRun(
    "legacy-top-level-run",
    "user:migration-owner-a",
    "legacy-top-level-session",
  );
  insertScheduledRun(
    "legacy-v2-envelope-run",
    "user:migration-owner-a",
    "legacy-v2-envelope-session",
  );
  insertScheduledRun(
    "legacy-large-owned-run",
    "user:migration-owner-a",
    "legacy-large-owned-session",
  );
  insertScheduledRun(
    "legacy-db-turn-run",
    "user:migration-owner-a",
    "legacy-db-turn-session",
    "legacy-db-turn-corrupt-metadata",
  );
  insertScheduledRun(
    "legacy-db-turn-overcap-run",
    "user:migration-owner-a",
    "legacy-db-turn-overcap-session",
    "legacy-db-turn-overcap-metadata",
  );
  insertScheduledRun(
    "legacy-db-owner-unknown-run",
    "unknown:migration-owner",
    "legacy-db-owner-unknown-session",
    "legacy-db-owner-unknown-turn",
  );
  insertScheduledRun(
    "legacy-db-priority-authoritative-run",
    "user:migration-owner-a",
    "legacy-db-priority-session",
    "legacy-db-priority-turn",
  );
  insertScheduledRun(
    "legacy-db-conflict-turn-run",
    "user:migration-owner-a",
    "legacy-db-conflict-session",
    "legacy-db-conflict-turn",
  );
  insertScheduledRun(
    "legacy-db-conflict-metadata-run",
    "user:migration-owner-b",
    "legacy-db-conflict-session",
  );
  insertScheduledRun(
    "legacy-db-mismatch-run",
    "user:migration-owner-a",
    "legacy-db-mismatch-session",
    "different-turn-than-legacy-input",
  );
  scheduled.close();

  db.migrate(MIGRATIONS);
  assert.equal(db.pragma("user_version"), 11);
  const columns = new Set(
    db.all("PRAGMA table_info(turn_inputs)").map((row) => row.name),
  );
  assert.equal(columns.has("migration_status"), true);
  assert.equal(columns.has("migration_reason"), true);
  assert.equal(columns.has("scheduled_session_barrier"), true);
  assert.equal(columns.has("external_desktop_device_id"), true);
  assert.equal(columns.has("external_mobile_device_id"), true);
  const externalTupleIndex = db.all("PRAGMA index_list(turn_inputs)")
    .find((index) => index.name === "idx_turn_inputs_external_idempotency");
  assert.equal(
    externalTupleIndex?.unique,
    1,
    "the exact mobile tuple must be protected by a unique index",
  );
  const externalTuplePlan = db.all(
    `EXPLAIN QUERY PLAN
     SELECT * FROM turn_inputs
     WHERE external_desktop_device_id = ?
       AND external_mobile_device_id = ?
       AND external_idempotency_key = ?
       AND migration_status = 'owned'`,
    "legacy-external-owned-desktop",
    "legacy-external-owned-mobile",
    "legacy-external-owned-key",
  );
  assert.ok(
    externalTuplePlan.some((entry) => String(entry.detail).includes(
      "idx_turn_inputs_external_idempotency",
    )),
    `mobile tuple lookup must use its unique index: ${JSON.stringify(externalTuplePlan)}`,
  );

  const character = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-character-turn",
  );
  assert.equal(character.owner_scope, ownerA);
  assert.equal(character.migration_status, "owned");

  const scheduledOwned = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-scheduled-turn",
  );
  assert.equal(scheduledOwned.owner_scope, "legacy_ambiguous");
  assert.equal(scheduledOwned.migration_status, "quarantined_conflict");
  assert.equal(scheduledOwned.scheduled_task_run_id, "legacy-scheduled-run");
  const scheduledDuplicate = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-scheduled-duplicate-turn",
  );
  assert.equal(scheduledDuplicate.owner_scope, "legacy_ambiguous");
  assert.equal(scheduledDuplicate.migration_status, "quarantined_conflict");
  assert.equal(scheduledDuplicate.scheduled_task_run_id, null);
  assert.equal(scheduledOwned.scheduled_session_barrier, 0);
  assert.equal(scheduledDuplicate.scheduled_session_barrier, 0);

  const conflict = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-conflict-turn",
  );
  assert.notEqual(conflict.owner_scope, ownerA);
  assert.notEqual(conflict.owner_scope, ownerB);
  assert.notEqual(conflict.owner_scope, "");
  assert.equal(conflict.migration_status, "quarantined_conflict");
  assert.equal(conflict.migration_reason, "owner_evidence_conflict");

  for (const turnId of [
    "legacy-unknown-turn",
    "legacy-missing-run-turn",
    "legacy-external-turn",
  ]) {
    const row = db.get("SELECT * FROM turn_inputs WHERE turn_id = ?", turnId);
    assert.notEqual(row.owner_scope, ownerA);
    assert.notEqual(row.owner_scope, ownerB);
    assert.notEqual(row.owner_scope, "");
    assert.equal(row.migration_status, "legacy_ambiguous");
  }

  for (const {
    turnId,
    runId,
    reason,
  } of [
    {
      turnId: "legacy-top-level-turn",
      runId: "legacy-top-level-run",
      reason: "scheduled_run_verified",
    },
    {
      turnId: "legacy-v2-envelope-turn",
      runId: "legacy-v2-envelope-run",
      reason: "scheduled_run_verified",
    },
    {
      turnId: "legacy-large-owned-turn",
      runId: "legacy-large-owned-run",
      reason: "scheduled_run_verified",
    },
    {
      turnId: "legacy-db-turn-corrupt-metadata",
      runId: "legacy-db-turn-run",
      reason: "scheduled_turn_verified",
    },
    {
      turnId: "legacy-db-turn-overcap-metadata",
      runId: "legacy-db-turn-overcap-run",
      reason: "scheduled_turn_verified",
    },
    {
      turnId: "legacy-db-priority-turn",
      runId: "legacy-db-priority-authoritative-run",
      reason: "scheduled_turn_verified",
    },
  ]) {
    const row = db.get("SELECT * FROM turn_inputs WHERE turn_id = ?", turnId);
    assert.equal(row.owner_scope, ownerA);
    assert.equal(row.migration_status, "owned");
    assert.equal(row.migration_reason, reason);
    assert.equal(row.scheduled_task_run_id, runId);
    assert.equal(row.scheduled_session_barrier, 0);
  }

  const largeAmbiguous = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-large-ambiguous-turn",
  );
  assert.equal(
    Buffer.byteLength(largeAmbiguous.metadata_json, "utf8"),
    71_928,
  );
  assert.equal(
    largeAmbiguous.scheduled_task_run_id,
    "legacy-large-ambiguous-run",
  );
  assert.equal(largeAmbiguous.migration_status, "legacy_ambiguous");
  assert.equal(
    largeAmbiguous.migration_reason,
    "scheduled_identity_unverified",
  );
  assert.equal(largeAmbiguous.scheduled_session_barrier, 0);

  const unknownDbOwner = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-db-owner-unknown-turn",
  );
  assert.equal(
    unknownDbOwner.scheduled_task_run_id,
    "legacy-db-owner-unknown-run",
  );
  assert.equal(unknownDbOwner.migration_status, "legacy_ambiguous");
  assert.equal(unknownDbOwner.migration_reason, "scheduled_owner_unresolved");
  assert.equal(unknownDbOwner.scheduled_session_barrier, 0);

  const dbEvidenceConflict = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-db-conflict-turn",
  );
  assert.equal(dbEvidenceConflict.owner_scope, "legacy_ambiguous");
  assert.equal(
    dbEvidenceConflict.migration_status,
    "quarantined_conflict",
  );
  assert.equal(
    dbEvidenceConflict.migration_reason,
    "scheduled_evidence_conflict",
  );
  assert.equal(dbEvidenceConflict.scheduled_session_barrier, 1);

  const dbTurnMismatch = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-db-mismatch-turn",
  );
  assert.equal(dbTurnMismatch.owner_scope, "legacy_ambiguous");
  assert.equal(dbTurnMismatch.migration_status, "quarantined_conflict");
  assert.equal(dbTurnMismatch.migration_reason, "scheduled_turn_mismatch");
  assert.equal(dbTurnMismatch.scheduled_session_barrier, 1);

  const taskHint = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-task-hint-turn",
  );
  assert.equal(taskHint.scheduled_task_run_id, null);
  assert.equal(taskHint.migration_reason, "scheduled_hint_unresolved");
  assert.equal(taskHint.scheduled_session_barrier, 1);

  const identityConflict = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-identity-conflict-turn",
  );
  assert.equal(identityConflict.scheduled_task_run_id, null);
  assert.equal(identityConflict.migration_reason, "metadata_identity_conflict");
  assert.equal(identityConflict.scheduled_session_barrier, 1);

  const corruptOrdinary = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-corrupt-ordinary-turn",
  );
  assert.equal(corruptOrdinary.migration_reason, "metadata_corrupt");
  assert.equal(corruptOrdinary.scheduled_session_barrier, 0);

  const externalTop = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-external-top-turn",
  );
  assert.equal(
    externalTop.external_command_id,
    "legacy-external-top-command",
  );
  assert.equal(externalTop.external_desktop_device_id, null);
  assert.equal(externalTop.external_mobile_device_id, null);
  const externalAmbiguous = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-external-turn",
  );
  assert.equal(externalAmbiguous.owner_scope, "legacy_ambiguous");
  assert.equal(
    externalAmbiguous.external_desktop_device_id,
    "legacy-external-desktop",
    "a safely parsed ambiguous legacy tuple must become a global tombstone",
  );
  assert.equal(
    externalAmbiguous.external_mobile_device_id,
    "legacy-external-mobile",
  );
  const commandAlias = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-command-alias-turn",
  );
  assert.equal(commandAlias.external_command_id, "legacy-command-alias");

  const externalOwned = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-external-owned-turn",
  );
  assert.equal(externalOwned.owner_scope, ownerA);
  assert.equal(
    externalOwned.external_desktop_device_id,
    "legacy-external-owned-desktop",
  );
  assert.equal(
    externalOwned.external_mobile_device_id,
    "legacy-external-owned-mobile",
  );
  assert.equal(
    externalOwned.external_idempotency_key,
    "legacy-external-owned-key",
  );
  const externalOwnedDuplicate = db.get(
    "SELECT * FROM turn_inputs WHERE turn_id = ?",
    "legacy-external-owned-duplicate-turn",
  );
  assert.equal(externalOwnedDuplicate.owner_scope, ownerA);
  assert.equal(externalOwnedDuplicate.external_desktop_device_id, null);
  assert.equal(externalOwnedDuplicate.external_mobile_device_id, null);
  assert.equal(
    externalOwnedDuplicate.migration_reason,
    "legacy_external_identity_duplicate",
  );
  assert.equal(
    db.get(
      `SELECT COUNT(*) AS count FROM turn_inputs
       WHERE external_desktop_device_id = 'legacy-external-owned-desktop'
         AND external_mobile_device_id = 'legacy-external-owned-mobile'
         AND external_idempotency_key = 'legacy-external-owned-key'`,
    ).count,
    1,
    "v7 backfill preserves only one global device-tuple identity",
  );

  for (const [sql, indexName, key] of [
    [
      QUARANTINE_SCHEDULED_SQL,
      "idx_turn_inputs_quarantine_scheduled",
      "legacy-large-ambiguous-run",
    ],
    [
      QUARANTINE_EXTERNAL_SQL,
      "idx_turn_inputs_quarantine_external",
      "legacy-external-top-command",
    ],
  ]) {
    const plan = db.all(
      `EXPLAIN QUERY PLAN ${sql}`,
      indexName.includes("scheduled") ? "legacy-large-ambiguous-session" : "legacy-external-top-session",
      key,
    );
    assert.ok(
      plan.some((entry) => String(entry.detail).includes(indexName)),
      `${indexName} must serve its exact quarantine query: ${JSON.stringify(plan)}`,
    );
  }
  db.close();

  store = new MessageStore(dbPath, blobDir);
  assert.equal(
    store.pendingTurnInputs(
      "legacy-external-owned-session",
      ownerA,
    ).some((turn) => turn.turnId === "legacy-external-owned-turn"),
    true,
    "a uniquely backfilled legacy mobile tuple remains safely recoverable",
  );
  assert.equal(
    store.pendingTurnInputs(
      "legacy-external-owned-duplicate-session",
      ownerA,
    ).some(
      (turn) => turn.turnId === "legacy-external-owned-duplicate-turn",
    ),
    false,
    "an ambiguous legacy mobile tuple is never automatically recovered",
  );
  assert.equal(
    store.claimTurnInputDispatch(
      "legacy-external-owned-duplicate-session",
      "legacy-external-owned-duplicate-turn",
      {
        attemptId: "must-not-claim-ambiguous-mobile",
        ownerScope: ownerA,
      },
    ).ok,
    false,
    "an ambiguous legacy mobile tuple cannot bypass recovery filtering",
  );
  assert.equal(
    store.getTurnInputByTurnId("legacy-character-turn", ownerA)?.turnId,
    "legacy-character-turn",
  );
  assert.equal(store.getTurnInputByTurnId("legacy-character-turn", ownerB), null);
  assert.equal(store.getTurnInputByTurnId("legacy-unknown-turn", ownerA), null);
  assert.equal(store.getTurnInputByTurnId("legacy-unknown-turn", ownerB), null);
  assert.equal(
    store.claimTurnInputDispatch(
      "legacy-unknown-session",
      "legacy-unknown-turn",
      { attemptId: "must-not-claim-legacy-unknown", ownerScope: ownerA },
    ).ok,
    false,
  );

  const inheritedA = store.admitTurnInput(
    "legacy-character-session",
    {
      turnId: "legacy-character-retry-a",
      delivery: "direct",
      userText: "retry A",
    },
    { ownerScope: ownerA, sourceTurnId: "legacy-character-turn" },
  );
  assert.equal(
    inheritedA.metadata.characterWorlds.characterRevisionId,
    revisionA,
  );
  assert.equal(inheritedA.metadata.characterWorlds.snapshotStatus, "ready");

  const inheritedB = store.admitTurnInput(
    "legacy-character-session",
    {
      turnId: "legacy-character-retry-b",
      delivery: "direct",
      userText: "retry B",
    },
    { ownerScope: ownerB, sourceTurnId: "legacy-character-turn" },
  );
  assert.equal(inheritedB.metadata.characterWorlds.snapshotStatus, "fallback");
  assert.equal(inheritedB.metadata.characterWorlds.characterRevisionId, null);

  assert.equal(
    store.findTurnInputByAdmissionKey(
      "legacy-scheduled-session",
      ownerA,
      "scheduled_task_run_id",
      "legacy-scheduled-run",
    ),
    null,
  );
  assert.equal(
    store.findTurnInputByAdmissionKey(
      "legacy-scheduled-session",
      ownerB,
      "scheduled_task_run_id",
      "legacy-scheduled-run",
    ),
    null,
  );
  assert.equal(
    store.pendingTurnInputs("legacy-scheduled-session", ownerA).length,
    0,
    "ambiguous legacy duplicates must never enter automatic recovery",
  );
  assert.equal(
    store.findTurnInputByAdmissionKey(
      "legacy-missing-run-session",
      ownerA,
      "scheduled_task_run_id",
      "legacy-missing-run",
    ),
    null,
  );

  const countBefore = store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    "legacy-missing-run-session",
  ).count;
  const ambiguousReplay = store.admitQueuedTurnInput(
    "legacy-missing-run-session",
    {
      turnId: "legacy-missing-run-replay",
      delivery: "queue",
      userText: "must not claim ambiguous legacy work",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: { id: "legacy-missing-run-replay-item", displayFiles: [] },
        options: {
          scheduledTaskRunId: "legacy-missing-run",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(ambiguousReplay.ok, false);
  assert.equal(ambiguousReplay.error, "LEGACY_ADMISSION_AMBIGUOUS");
  assert.equal(ambiguousReplay.turn, null);
  assert.equal(
    store.db.get(
      "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
      "legacy-missing-run-session",
    ).count,
    countBefore,
  );

  const duplicateReplay = store.admitQueuedTurnInput(
    "legacy-scheduled-session",
    {
      turnId: "legacy-scheduled-replay",
      delivery: "queue",
      userText: "must not choose one historical duplicate",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: { id: "legacy-scheduled-replay-item", displayFiles: [] },
        options: {
          scheduledTaskRunId: "legacy-scheduled-run",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(duplicateReplay.ok, false);
  assert.equal(duplicateReplay.error, "LEGACY_ADMISSION_AMBIGUOUS");

  const ambiguousMobileCountBefore = store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs",
  ).count;
  const ambiguousMobileReplay = store.admitQueuedTurnInput(
    "new-session-for-ambiguous-mobile-tuple",
    {
      turnId: "legacy-external-tuple-replay",
      delivery: "queue",
      userText: "must not bypass a quarantined tuple with a new command id",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: {
          id: "legacy-external-tuple-replay-item",
          displayFiles: [],
        },
        options: {
          queueOrigin: "mobile_command",
          externalCommand: {
            commandId: "new-command-for-old-tuple",
            idempotencyKey: "legacy-external-key",
            payloadHash: "legacy-external-hash",
            desktopDeviceId: "legacy-external-desktop",
            mobileDeviceId: "legacy-external-mobile",
          },
        },
      }),
    },
  );
  assert.equal(ambiguousMobileReplay.ok, false);
  assert.equal(
    store.db.get("SELECT COUNT(*) AS count FROM turn_inputs").count,
    ambiguousMobileCountBefore,
    "a quarantined legacy tuple cannot admit a second side effect",
  );

  const largeCountBefore = store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    "legacy-large-ambiguous-session",
  ).count;
  const largeReplay = store.admitQueuedTurnInput(
    "legacy-large-ambiguous-session",
    {
      turnId: "legacy-large-ambiguous-replay",
      delivery: "queue",
      userText: "must preserve the 71928 byte historical key",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: { id: "legacy-large-ambiguous-replay-item", displayFiles: [] },
        options: {
          scheduledTaskRunId: "legacy-large-ambiguous-run",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(largeReplay.ok, false);
  assert.equal(largeReplay.error, "LEGACY_ADMISSION_AMBIGUOUS");
  assert.equal(
    store.db.get(
      "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
      "legacy-large-ambiguous-session",
    ).count,
    largeCountBefore,
  );

  const differentLargeRun = store.admitQueuedTurnInput(
    "legacy-large-ambiguous-session",
    {
      turnId: "legacy-large-ambiguous-different-run",
      delivery: "queue",
      userText: "a different run is independent of the quarantined exact key",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: {
          id: "legacy-large-ambiguous-different-item",
          displayFiles: [],
        },
        options: {
          scheduledTaskRunId: "legacy-large-ambiguous-new-run",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(differentLargeRun.ok, true);

  const differentDuplicateRun = store.admitQueuedTurnInput(
    "legacy-scheduled-session",
    {
      turnId: "legacy-scheduled-different-run",
      delivery: "queue",
      userText: "an exact duplicate quarantine must not block another run",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: { id: "legacy-scheduled-different-item", displayFiles: [] },
        options: {
          scheduledTaskRunId: "legacy-scheduled-new-run",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(differentDuplicateRun.ok, true);

  const sessionBarrier = store.admitQueuedTurnInput(
    "legacy-task-hint-session",
    {
      turnId: "legacy-task-hint-new-run",
      delivery: "queue",
      userText: "must not guess around a legacy scheduled task",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: { id: "legacy-task-hint-new-item", displayFiles: [] },
        options: {
          scheduledTaskRunId: "different-run-in-blocked-session",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(sessionBarrier.ok, false);
  assert.equal(sessionBarrier.error, "LEGACY_ADMISSION_AMBIGUOUS");

  const conflictBarrier = store.admitQueuedTurnInput(
    "legacy-identity-conflict-session",
    {
      turnId: "legacy-identity-conflict-new-run",
      delivery: "queue",
      userText: "identity conflict must conservatively block the session",
    },
    {
      ownerScope: ownerA,
      queueRecoveryEnvelope: createQueueRecoveryEnvelope({
        item: { id: "legacy-identity-conflict-new-item", displayFiles: [] },
        options: {
          scheduledTaskRunId: "legacy-identity-conflict-new-run-id",
          queueOrigin: "scheduled_task",
        },
      }),
    },
  );
  assert.equal(conflictBarrier.ok, false);
  assert.equal(conflictBarrier.error, "LEGACY_ADMISSION_AMBIGUOUS");

  const directControl = store.admitTurnInput(
    "legacy-task-hint-session",
    {
      turnId: "legacy-task-hint-direct-control",
      delivery: "direct",
      userText: "ordinary direct work remains available",
    },
    { ownerScope: ownerA },
  );
  assert.equal(directControl.turnId, "legacy-task-hint-direct-control");

  console.log("turn-admission-migration: ok");
} finally {
  store?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
