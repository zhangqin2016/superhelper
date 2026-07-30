"use strict";

const {
  LEGACY_AMBIGUOUS_OWNER_SCOPE,
  TURN_INPUT_MIGRATION_OWNED,
} = require("./turn-admission-migration");

const MAX_ADMISSION_KEY_BYTES = 512;
const QUARANTINE_SCHEDULED_SQL = `
  SELECT 1 AS present FROM turn_inputs
    INDEXED BY idx_turn_inputs_quarantine_scheduled
  WHERE owner_scope = '${LEGACY_AMBIGUOUS_OWNER_SCOPE}'
    AND session_id = ? AND scheduled_task_run_id = ?
    AND migration_status <> 'owned'
  LIMIT 1`;
const QUARANTINE_EXTERNAL_SQL = `
  SELECT 1 AS present FROM turn_inputs
    INDEXED BY idx_turn_inputs_quarantine_external
  WHERE owner_scope = '${LEGACY_AMBIGUOUS_OWNER_SCOPE}'
    AND session_id = ? AND external_command_id = ?
    AND migration_status <> 'owned'
  LIMIT 1`;
const QUARANTINE_SCHEDULED_SESSION_SQL = `
  SELECT 1 AS present FROM turn_inputs
    INDEXED BY idx_turn_inputs_quarantine_scheduled_session
  WHERE owner_scope = '${LEGACY_AMBIGUOUS_OWNER_SCOPE}'
    AND session_id = ? AND scheduled_session_barrier = 1
    AND migration_status <> 'owned'
  LIMIT 1`;

function boundedAdmissionKey(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_ADMISSION_KEY_BYTES
    || Buffer.byteLength(value, "utf8") > MAX_ADMISSION_KEY_BYTES
  ) return null;
  return value;
}

function createTurnAdmissionStoreMethods({
  hydrateTurnInput,
  normalizeQueueRecoveryEnvelope,
  serializeTurnMetadata,
  snapshotCurrentCharacterBinding,
  snapshotInheritedCharacterBinding,
  stringifyJson,
}) {
  function admissionKeys(admissionContext = {}) {
    const recovery = normalizeQueueRecoveryEnvelope(
      admissionContext.queueRecoveryEnvelope,
    );
    if (!recovery) {
      return {
        recovery: null,
        scheduledTaskRunId: null,
        externalCommandId: null,
        externalIdempotencyKey: null,
        externalPayloadHash: null,
        externalDesktopDeviceId: null,
        externalMobileDeviceId: null,
      };
    }
    const external = recovery.options?.externalCommand;
    const scheduledTaskRunId = recovery.options?.scheduledTaskRunId == null
      ? null
      : boundedAdmissionKey(recovery.options.scheduledTaskRunId);
    const externalCommandId = external?.commandId == null
      ? null
      : boundedAdmissionKey(external.commandId);
    const externalIdempotencyKey = external?.idempotencyKey == null
      ? null
      : boundedAdmissionKey(external.idempotencyKey);
    const externalPayloadHash = external?.payloadHash == null
      ? null
      : boundedAdmissionKey(external.payloadHash);
    const externalDesktopDeviceId = external?.desktopDeviceId == null
      ? null
      : boundedAdmissionKey(external.desktopDeviceId);
    const externalMobileDeviceId = external?.mobileDeviceId == null
      ? null
      : boundedAdmissionKey(external.mobileDeviceId);
    if (
      (recovery.options?.scheduledTaskRunId != null && !scheduledTaskRunId)
      || (external?.commandId != null && !externalCommandId)
      || (external?.idempotencyKey != null && !externalIdempotencyKey)
      || (external?.payloadHash != null && !externalPayloadHash)
      || (
        external?.desktopDeviceId != null
        && !externalDesktopDeviceId
      )
      || (
        external?.mobileDeviceId != null
        && !externalMobileDeviceId
      )
      || (
        externalCommandId
        && (
          !externalIdempotencyKey
          || !externalPayloadHash
          || !externalDesktopDeviceId
          || !externalMobileDeviceId
        )
      )
    ) {
      return { error: "ADMISSION_KEY_INVALID", recovery };
    }
    return {
      recovery,
      scheduledTaskRunId,
      externalCommandId,
      externalIdempotencyKey,
      externalPayloadHash,
      externalDesktopDeviceId,
      externalMobileDeviceId,
    };
  }

  function existingAdmissionRow(db, sessionId, ownerScope, turnId, keys) {
    const exactTurn = db.get(
      `SELECT * FROM turn_inputs
       WHERE turn_id = ? AND session_id = ? AND owner_scope = ?
         AND migration_status = ?
       LIMIT 1`,
      turnId,
      sessionId,
      ownerScope,
      TURN_INPUT_MIGRATION_OWNED,
    );
    if (exactTurn) return exactTurn;
    if (keys.scheduledTaskRunId) {
      const scheduled = db.get(
        `SELECT * FROM turn_inputs
         WHERE owner_scope = ? AND session_id = ?
           AND scheduled_task_run_id = ? AND migration_status = ?
         ORDER BY admitted_seq LIMIT 1`,
        ownerScope,
        sessionId,
        keys.scheduledTaskRunId,
        TURN_INPUT_MIGRATION_OWNED,
      );
      if (scheduled) return scheduled;
    }
    if (
      keys.externalDesktopDeviceId
      && keys.externalMobileDeviceId
      && keys.externalIdempotencyKey
    ) {
      const external = db.get(
        `SELECT * FROM turn_inputs
         WHERE external_desktop_device_id = ?
           AND external_mobile_device_id = ?
           AND external_idempotency_key = ?
           AND migration_status = ?
         ORDER BY created_at, admitted_seq LIMIT 1`,
        keys.externalDesktopDeviceId,
        keys.externalMobileDeviceId,
        keys.externalIdempotencyKey,
        TURN_INPUT_MIGRATION_OWNED,
      );
      if (external) return external;
    }
    if (!keys.externalCommandId) return null;
    return db.get(
      `SELECT * FROM turn_inputs
       WHERE owner_scope = ? AND session_id = ?
         AND external_command_id = ? AND migration_status = ?
       ORDER BY admitted_seq LIMIT 1`,
      ownerScope,
      sessionId,
      keys.externalCommandId,
      TURN_INPUT_MIGRATION_OWNED,
    );
  }

  function hasQuarantinedAdmission(db, sessionId, keys) {
    if (keys.scheduledTaskRunId) {
      if (db.get(
        QUARANTINE_SCHEDULED_SQL,
        sessionId,
        keys.scheduledTaskRunId,
      )) return true;
      if (db.get(QUARANTINE_SCHEDULED_SESSION_SQL, sessionId)) return true;
    }
    if (keys.externalCommandId) {
      return Boolean(db.get(
        QUARANTINE_EXTERNAL_SQL,
        sessionId,
        keys.externalCommandId,
      ));
    }
    return false;
  }

  function admitTurnInputResult(
    sessionId,
    input = {},
    admissionContext = {},
    requireQueueRecovery = false,
  ) {
    const sid = String(sessionId || "");
    const turnId = String(input.turnId || "");
    if (!sid || !turnId) throw new Error("admitTurnInput requires sessionId and turnId");
    return this.db.transaction(() => {
      const ownerScope = typeof admissionContext.ownerScope === "string"
        ? admissionContext.ownerScope
        : "";
      const keys = admissionKeys(admissionContext);
      if (keys.error) {
        return Object.freeze({ ok: false, error: keys.error, inserted: false, turn: null });
      }
      if (requireQueueRecovery && !keys.recovery) {
        return Object.freeze({
          ok: false,
          error: "QUEUE_RECOVERY_INVALID",
          inserted: false,
          turn: null,
        });
      }
      if (
        (keys.scheduledTaskRunId || keys.externalCommandId)
        && !boundedAdmissionKey(ownerScope)
      ) {
        return Object.freeze({
          ok: false,
          error: "OWNER_SCOPE_UNAVAILABLE",
          inserted: false,
          turn: null,
        });
      }
      if (hasQuarantinedAdmission(this.db, sid, keys)) {
        return Object.freeze({
          ok: false,
          error: "LEGACY_ADMISSION_AMBIGUOUS",
          inserted: false,
          turn: null,
        });
      }
      const characterWorldsSnapshot = Object.hasOwn(admissionContext, "sourceTurnId")
        ? snapshotInheritedCharacterBinding(
            this.db,
            sid,
            admissionContext.sourceTurnId,
            ownerScope,
          )
        : snapshotCurrentCharacterBinding(this.db, sid, ownerScope);
      const admittedSeq = this.db.get(
        `SELECT COALESCE(MAX(admitted_seq), 0) + 1 AS next
         FROM turn_inputs WHERE session_id = ?`,
        sid,
      ).next;
      const inserted = this.db.run(
        `INSERT INTO turn_inputs
           (session_id, admitted_seq, turn_id, delivery, status, user_text,
            files_json, metadata_json, created_at, owner_scope,
            migration_status, migration_reason, scheduled_session_barrier,
            scheduled_task_run_id, external_command_id,
            external_idempotency_key, external_payload_hash,
            external_desktop_device_id, external_mobile_device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        sid,
        admittedSeq,
        turnId,
        input.delivery || "queue",
        input.status || "admitted",
        String(input.userText || ""),
        stringifyJson(Array.isArray(input.files) ? input.files : [], []),
        serializeTurnMetadata(
          input.metadata,
          characterWorldsSnapshot,
          keys.recovery,
        ),
        Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
        ownerScope,
        TURN_INPUT_MIGRATION_OWNED,
        "current_admission",
        0,
        keys.scheduledTaskRunId,
        keys.externalCommandId,
        keys.externalIdempotencyKey,
        keys.externalPayloadHash,
        keys.externalDesktopDeviceId,
        keys.externalMobileDeviceId,
      );
      let row = inserted.changes === 1
        ? this.db.get(
            `SELECT * FROM turn_inputs
             WHERE turn_id = ? AND session_id = ? AND owner_scope = ?
               AND migration_status = ?`,
            turnId,
            sid,
            ownerScope,
            TURN_INPUT_MIGRATION_OWNED,
          )
        : existingAdmissionRow(this.db, sid, ownerScope, turnId, keys);
      if (!row) {
        return Object.freeze({
          ok: false,
          error: "ADMISSION_CONFLICT_UNRESOLVED",
          inserted: false,
          turn: null,
        });
      }
      if (
        keys.externalDesktopDeviceId
        && row.owner_scope !== ownerScope
      ) {
        return Object.freeze({
          ok: false,
          error: "EXTERNAL_IDENTITY_OWNERSHIP_MISMATCH",
          inserted: false,
          duplicate: true,
          turn: null,
        });
      }
      const existingTurn = hydrateTurnInput(row);
      if (
        inserted.changes !== 1
        && row.turn_id === turnId
        && row.session_id === sid
        && row.owner_scope === ownerScope
        && row.status === "admitted"
        && row.delivery === "local"
        && existingTurn.metadata.echoed === true
        && keys.recovery
      ) {
        const adopted = this.db.run(
          `UPDATE OR IGNORE turn_inputs
           SET delivery = 'queue', user_text = ?, files_json = ?,
               metadata_json = ?, scheduled_task_run_id = ?,
               external_command_id = ?, external_idempotency_key = ?,
               external_payload_hash = ?,
               external_desktop_device_id = ?,
               external_mobile_device_id = ?
           WHERE turn_id = ? AND session_id = ? AND owner_scope = ?
             AND migration_status = ?
             AND status = 'admitted' AND delivery = 'local'`,
          String(input.userText || ""),
          stringifyJson(Array.isArray(input.files) ? input.files : [], []),
          serializeTurnMetadata(
            { ...existingTurn.metadata, ...input.metadata },
            existingTurn.metadata.characterWorlds || null,
            keys.recovery,
          ),
          keys.scheduledTaskRunId,
          keys.externalCommandId,
          keys.externalIdempotencyKey,
          keys.externalPayloadHash,
          keys.externalDesktopDeviceId,
          keys.externalMobileDeviceId,
          turnId,
          sid,
          ownerScope,
          TURN_INPUT_MIGRATION_OWNED,
        );
        if (adopted.changes === 1) {
          row = this.db.get(
            `SELECT * FROM turn_inputs
             WHERE turn_id = ? AND session_id = ? AND owner_scope = ?
               AND migration_status = ?`,
            turnId,
            sid,
            ownerScope,
            TURN_INPUT_MIGRATION_OWNED,
          );
          return Object.freeze({
            ok: true,
            inserted: false,
            adopted: true,
            duplicate: false,
            turn: hydrateTurnInput(row),
          });
        }
      }
      if (
        keys.externalCommandId
        && (
          row.external_payload_hash !== keys.externalPayloadHash
          || (
            row.external_idempotency_key !== keys.externalIdempotencyKey
          )
          || (
            row.external_desktop_device_id
              && row.external_desktop_device_id
                !== keys.externalDesktopDeviceId
          )
          || (
            row.external_mobile_device_id
              && row.external_mobile_device_id
                !== keys.externalMobileDeviceId
          )
          || (
            row.external_command_id === keys.externalCommandId
            && (
              row.external_desktop_device_id == null
              || row.external_mobile_device_id == null
            )
          )
        )
      ) {
        return Object.freeze({
          ok: false,
          error: "IDEMPOTENCY_CONFLICT",
          inserted: false,
          duplicate: true,
          turn: hydrateTurnInput(row),
        });
      }
      return Object.freeze({
        ok: true,
        inserted: inserted.changes === 1,
        duplicate: inserted.changes !== 1,
        turn: hydrateTurnInput(row),
      });
    })();
  }

  return {
    admitQueuedTurnInput(sessionId, input = {}, admissionContext = {}) {
      return admitTurnInputResult.call(this, sessionId, input, admissionContext, true);
    },

    admitTurnInput(sessionId, input = {}, admissionContext = {}) {
      const result = admitTurnInputResult.call(this, sessionId, input, admissionContext);
      if (!result.ok) {
        const error = new Error(result.error || "TURN_ADMISSION_FAILED");
        error.code = result.error || "TURN_ADMISSION_FAILED";
        throw error;
      }
      return result.turn;
    },

    findTurnInputByAdmissionKey(sessionId, ownerScope, column, value) {
      const sid = String(sessionId || "");
      const owner = boundedAdmissionKey(ownerScope);
      const key = boundedAdmissionKey(value);
      if (!sid || !owner || !key) return null;
      const allowedColumn = column === "scheduled_task_run_id"
        ? "scheduled_task_run_id"
        : column === "external_command_id"
          ? "external_command_id"
          : null;
      if (!allowedColumn) return null;
      const row = this.db.get(
        `SELECT * FROM turn_inputs
         WHERE owner_scope = ? AND migration_status = ?
           AND session_id = ? AND ${allowedColumn} = ?
         ORDER BY admitted_seq LIMIT 1`,
        owner,
        TURN_INPUT_MIGRATION_OWNED,
        sid,
        key,
      );
      return row ? hydrateTurnInput(row) : null;
    },

    findTurnInputByExternalIdentity(ownerScope, identity = {}) {
      const owner = boundedAdmissionKey(ownerScope);
      const desktopDeviceId = boundedAdmissionKey(identity.desktopDeviceId);
      const mobileDeviceId = boundedAdmissionKey(identity.mobileDeviceId);
      const idempotencyKey = boundedAdmissionKey(identity.idempotencyKey);
      if (!owner || !desktopDeviceId || !mobileDeviceId || !idempotencyKey) {
        return null;
      }
      const row = this.db.get(
        `SELECT * FROM turn_inputs
         WHERE external_desktop_device_id = ?
           AND external_mobile_device_id = ?
           AND external_idempotency_key = ?
           AND migration_status = ?
         ORDER BY created_at, admitted_seq LIMIT 1`,
        desktopDeviceId,
        mobileDeviceId,
        idempotencyKey,
        TURN_INPUT_MIGRATION_OWNED,
      );
      return row?.owner_scope === owner ? hydrateTurnInput(row) : null;
    },
  };
}

module.exports = {
  QUARANTINE_EXTERNAL_SQL,
  QUARANTINE_SCHEDULED_SQL,
  createTurnAdmissionStoreMethods,
};
