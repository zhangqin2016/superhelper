"use strict";

const {
  legacyAdmissionFacts,
} = require("./turn-admission-migration-metadata");
const {
  openScheduledEvidence,
} = require("./turn-admission-migration-scheduled");

const LEGACY_AMBIGUOUS_OWNER_SCOPE = "legacy_ambiguous";
const TURN_INPUT_MIGRATION_OWNED = "owned";
const TURN_INPUT_MIGRATION_AMBIGUOUS = "legacy_ambiguous";
const TURN_INPUT_MIGRATION_CONFLICT = "quarantined_conflict";
const MIGRATION_BATCH_SIZE = 256;

function characterRevisionOwner(db, revisionId) {
  if (!revisionId) return null;
  try {
    const row = db.get(
      "SELECT owner_scope FROM character_revisions WHERE id = ?",
      revisionId,
    );
    const ownerScope = typeof row?.owner_scope === "string"
      ? row.owner_scope
      : "";
    return ownerScope && ownerScope !== LEGACY_AMBIGUOUS_OWNER_SCOPE
      ? ownerScope
      : null;
  } catch {
    return null;
  }
}

function scheduledResolution(row, facts, scheduledEvidence) {
  const evidence = scheduledEvidence?.evidence(
    row.turn_id,
    row.session_id,
    facts.scheduledTaskRunIds,
  ) || {
    rows: [],
    turnMatchCount: 0,
    lookupFailed: false,
  };
  if (evidence.lookupFailed && facts.scheduledHint) {
    return {
      conflict: false,
      ownerScope: null,
      runId: facts.scheduledTaskRunId,
      reason: "scheduled_evidence_unavailable",
      scheduledHint: true,
      ownerUnresolved: true,
    };
  }
  if (evidence.rows.length > 1 || evidence.turnMatchCount > 1) {
    return {
      conflict: true,
      ownerScope: null,
      runId: null,
      reason: "scheduled_evidence_conflict",
      scheduledHint: true,
    };
  }
  const authoritative = evidence.rows[0] || null;
  if (
    authoritative?.turnId
    && authoritative.turnId !== row.turn_id
  ) {
    return {
      conflict: true,
      ownerScope: null,
      runId: authoritative.id,
      reason: "scheduled_turn_mismatch",
      scheduledHint: true,
    };
  }
  if (authoritative) {
    return {
      conflict: false,
      ownerScope: authoritative.ownerScope,
      runId: authoritative.id,
      reason: evidence.turnMatchCount === 1
        ? "scheduled_turn_verified"
        : "scheduled_run_verified",
      scheduledHint: true,
      ownerUnresolved: !authoritative.ownerScope,
    };
  }
  return {
    conflict: false,
    ownerScope: null,
    runId: facts.scheduledTaskRunId,
    reason: null,
    scheduledHint: facts.scheduledHint,
    ownerUnresolved: false,
  };
}

function resolveMigration(db, row, facts, scheduledEvidence) {
  const scheduled = scheduledResolution(row, facts, scheduledEvidence);
  const characterOwner = characterRevisionOwner(
    db,
    facts.characterRevisionId,
  );
  const scheduledHint = scheduled.scheduledHint || facts.scheduledHint;
  const hasUniqueScheduledRunId = Boolean(
    scheduled.runId
    && !facts.identityConflict
    && !scheduled.conflict,
  );
  const barrier = row.delivery === "queue"
    && scheduledHint
    && !hasUniqueScheduledRunId
    ? 1
    : 0;
  if (facts.identityConflict || scheduled.conflict) {
    return {
      ownerScope: LEGACY_AMBIGUOUS_OWNER_SCOPE,
      migrationStatus: TURN_INPUT_MIGRATION_CONFLICT,
      migrationReason: facts.identityConflict
        ? "metadata_identity_conflict"
        : scheduled.reason,
      scheduledTaskRunId: scheduled.runId,
      scheduledSessionBarrier: barrier,
    };
  }
  if (scheduled.ownerUnresolved) {
    return {
      ownerScope: LEGACY_AMBIGUOUS_OWNER_SCOPE,
      migrationStatus: TURN_INPUT_MIGRATION_AMBIGUOUS,
      migrationReason: scheduled.reason === "scheduled_evidence_unavailable"
        ? scheduled.reason
        : "scheduled_owner_unresolved",
      scheduledTaskRunId: scheduled.runId,
      scheduledSessionBarrier: barrier,
    };
  }
  const owners = new Set([
    scheduled.ownerScope,
    characterOwner,
  ].filter(Boolean));
  if (owners.size > 1) {
    return {
      ownerScope: LEGACY_AMBIGUOUS_OWNER_SCOPE,
      migrationStatus: TURN_INPUT_MIGRATION_CONFLICT,
      migrationReason: "owner_evidence_conflict",
      scheduledTaskRunId: scheduled.runId,
      scheduledSessionBarrier: barrier,
    };
  }
  if (owners.size === 1) {
    return {
      ownerScope: owners.values().next().value,
      migrationStatus: TURN_INPUT_MIGRATION_OWNED,
      migrationReason: scheduled.ownerScope
        ? scheduled.reason
        : "character_revision_verified",
      scheduledTaskRunId: scheduled.runId,
      scheduledSessionBarrier: 0,
    };
  }
  let migrationReason = facts.metadataStatus;
  if (scheduledHint) {
    migrationReason = scheduled.runId
      ? "scheduled_identity_unverified"
      : "scheduled_hint_unresolved";
  } else if (facts.externalHint) {
    migrationReason = "external_identity_unverified";
  } else if (migrationReason === "ok") {
    migrationReason = "no_authoritative_owner";
  }
  return {
    ownerScope: LEGACY_AMBIGUOUS_OWNER_SCOPE,
    migrationStatus: TURN_INPUT_MIGRATION_AMBIGUOUS,
    migrationReason,
    scheduledTaskRunId: scheduled.runId,
    scheduledSessionBarrier: barrier,
  };
}

function quarantineDuplicate(db, rowIds) {
  for (const rowId of rowIds) {
    db.run(
      `UPDATE turn_inputs
       SET owner_scope = ?, migration_status = ?,
           migration_reason = ?
       WHERE rowid = ?`,
      LEGACY_AMBIGUOUS_OWNER_SCOPE,
      TURN_INPUT_MIGRATION_CONFLICT,
      "duplicate_admission_key",
      rowId,
    );
  }
}

function migrateLegacyTurnAdmissions(db) {
  const scheduledEvidence = openScheduledEvidence(db.filePath);
  const seenScheduled = new Map();
  const seenCommands = new Map();
  let cursor = 0;
  try {
    while (true) {
      const rows = db.all(
        `SELECT rowid, session_id, turn_id, delivery, metadata_json
         FROM turn_inputs
         WHERE rowid > ?
         ORDER BY rowid
         LIMIT ?`,
        cursor,
        MIGRATION_BATCH_SIZE,
      );
      if (!rows.length) break;
      for (const row of rows) {
        cursor = Number(row.rowid);
        const facts = legacyAdmissionFacts(row.metadata_json);
        let resolution = resolveMigration(
          db,
          row,
          facts,
          scheduledEvidence,
        );
        const scheduledKey = resolution.scheduledTaskRunId
          ? `${row.session_id}\u0000${resolution.scheduledTaskRunId}`
          : null;
        const commandKey = facts.externalCommandId
          ? `${row.session_id}\u0000${facts.externalCommandId}`
          : null;
        const duplicateRowIds = new Set();
        const scheduledDuplicate = Boolean(
          scheduledKey && seenScheduled.has(scheduledKey),
        );
        if (scheduledDuplicate) {
          duplicateRowIds.add(seenScheduled.get(scheduledKey));
        }
        if (commandKey && seenCommands.has(commandKey)) {
          duplicateRowIds.add(seenCommands.get(commandKey));
        }
        if (duplicateRowIds.size) {
          quarantineDuplicate(db, duplicateRowIds);
          resolution = {
            ...resolution,
            ownerScope: LEGACY_AMBIGUOUS_OWNER_SCOPE,
            migrationStatus: TURN_INPUT_MIGRATION_CONFLICT,
            migrationReason: "duplicate_admission_key",
            scheduledSessionBarrier: scheduledDuplicate
              && !facts.identityConflict
              ? 0
              : resolution.scheduledSessionBarrier,
          };
        }
        const scheduledTaskRunId = scheduledKey
          && !seenScheduled.has(scheduledKey)
          ? resolution.scheduledTaskRunId
          : null;
        const externalCommandId = commandKey
          && !seenCommands.has(commandKey)
          ? facts.externalCommandId
          : null;
        if (scheduledKey && scheduledTaskRunId) {
          seenScheduled.set(scheduledKey, row.rowid);
        }
        if (commandKey && externalCommandId) {
          seenCommands.set(commandKey, row.rowid);
        }
        db.run(
          `UPDATE turn_inputs
           SET owner_scope = ?, migration_status = ?, migration_reason = ?,
               scheduled_session_barrier = ?,
               scheduled_task_run_id = ?, external_command_id = ?,
               external_idempotency_key = ?, external_payload_hash = ?
           WHERE rowid = ?`,
          resolution.ownerScope,
          resolution.migrationStatus,
          resolution.migrationReason,
          resolution.scheduledSessionBarrier,
          scheduledTaskRunId,
          externalCommandId,
          externalCommandId ? facts.externalIdempotencyKey : null,
          externalCommandId ? facts.externalPayloadHash : null,
          row.rowid,
        );
      }
    }
  } finally {
    scheduledEvidence?.close();
  }
}

module.exports = {
  LEGACY_AMBIGUOUS_OWNER_SCOPE,
  TURN_INPUT_MIGRATION_AMBIGUOUS,
  TURN_INPUT_MIGRATION_CONFLICT,
  TURN_INPUT_MIGRATION_OWNED,
  migrateLegacyTurnAdmissions,
};
