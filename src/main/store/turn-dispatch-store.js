"use strict";

const {
  TURN_INPUT_MIGRATION_OWNED,
} = require("./turn-admission-migration");

function createTurnDispatchStoreMethods({
  hydrateTurnInput,
  mergeTurnMetadata,
  normalizeQueueRecoveryEnvelope,
}) {
  function recoverableQueueEnvelope(turn) {
    const recovery = normalizeQueueRecoveryEnvelope(
      turn?.metadata?.queueRecovery,
    );
    if (!recovery) return null;
    const external = recovery.options?.externalCommand;
    if (!external) return recovery;
    return (
      typeof external === "object"
      && !Array.isArray(external)
      && turn.externalCommandId === external.commandId
      && turn.externalIdempotencyKey === external.idempotencyKey
      && turn.externalPayloadHash === external.payloadHash
      && turn.externalDesktopDeviceId === external.desktopDeviceId
      && turn.externalMobileDeviceId === external.mobileDeviceId
      && turn.externalCommandId
      && turn.externalIdempotencyKey
      && turn.externalPayloadHash
      && turn.externalDesktopDeviceId
      && turn.externalMobileDeviceId
    ) ? recovery : null;
  }

  function getTurnInput(db, turnId) {
    const row = db.get(
      `SELECT * FROM turn_inputs
       WHERE turn_id = ? AND migration_status = ?`,
      String(turnId || ""),
      TURN_INPUT_MIGRATION_OWNED,
    );
    return row ? hydrateTurnInput(row) : null;
  }

  return {
    claimTurnInputDispatch(sessionId, turnId, claim = {}) {
      const sid = String(sessionId || "");
      const tid = String(turnId || "");
      const attemptId = String(claim.attemptId || "");
      const owner = typeof claim.ownerScope === "string" && claim.ownerScope
        ? claim.ownerScope
        : null;
      const startedAt = Number.isFinite(claim.startedAt) ? claim.startedAt : Date.now();
      if (
        !sid
        || !tid
        || !attemptId
        || !owner
        || attemptId.length > 512
        || Buffer.byteLength(attemptId, "utf8") > 512
      ) return Object.freeze({ ok: false, reason: "INVALID_CLAIM", turn: null });
      return this.db.transaction(() => {
        const row = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE turn_id = ? AND session_id = ? AND migration_status = ?
             AND owner_scope = ?`,
          tid,
          sid,
          TURN_INPUT_MIGRATION_OWNED,
          owner,
        );
        if (!row) return Object.freeze({ ok: false, reason: "NOT_FOUND", turn: null });
        const current = hydrateTurnInput(row);
        if (row.status !== "admitted") {
          return Object.freeze({ ok: false, reason: "STATUS", turn: current });
        }
        if (
          row.delivery === "queue"
          && !recoverableQueueEnvelope(current)
        ) {
          return Object.freeze({
            ok: false,
            reason: "INVALID_QUEUE_ENVELOPE",
            turn: current,
          });
        }
        const updated = this.db.run(
          `UPDATE turn_inputs
           SET status = 'dispatching', dispatch_attempt_id = ?, dispatch_started_at = ?
           WHERE turn_id = ? AND session_id = ? AND status = 'admitted'
             AND migration_status = ?
             AND owner_scope = ?`,
          attemptId,
          startedAt,
          tid,
          sid,
          TURN_INPUT_MIGRATION_OWNED,
          owner,
        );
        if (updated.changes !== 1) {
          const raced = this.db.get(
            `SELECT * FROM turn_inputs
             WHERE turn_id = ? AND session_id = ? AND migration_status = ?
               AND owner_scope = ?`,
            tid,
            sid,
            TURN_INPUT_MIGRATION_OWNED,
            owner,
          );
          return Object.freeze({
            ok: false,
            reason: "CAS_LOST",
            turn: raced ? hydrateTurnInput(raced) : null,
          });
        }
        const claimed = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE turn_id = ? AND session_id = ? AND migration_status = ?
             AND owner_scope = ?`,
          tid,
          sid,
          TURN_INPUT_MIGRATION_OWNED,
          owner,
        );
        return Object.freeze({
          ok: true,
          attemptId,
          turn: claimed ? hydrateTurnInput(claimed) : null,
        });
      })();
    },

    markTurnInputPromoted(turnId, patch = {}) {
      const tid = String(turnId || "");
      const attemptId = String(patch.dispatchAttemptId || "");
      if (!tid || !attemptId) return null;
      return this.db.transaction(() => {
        const row = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE turn_id = ? AND migration_status = ?`,
          tid,
          TURN_INPUT_MIGRATION_OWNED,
        );
        if (
          !row
          || row.status !== "dispatching"
          || row.dispatch_attempt_id !== attemptId
        ) return null;
        const status = patch.status === "accepted" ? "accepted" : "promoted";
        const acceptedAt = Number.isFinite(patch.acceptedAt) ? patch.acceptedAt : Date.now();
        const updated = this.db.run(
          `UPDATE turn_inputs
           SET status = ?, accepted_at = COALESCE(accepted_at, ?),
               promoted_at = COALESCE(promoted_at, ?), metadata_json = ?
           WHERE turn_id = ? AND status = 'dispatching' AND dispatch_attempt_id = ?`,
          status,
          acceptedAt,
          Number.isFinite(patch.promotedAt) ? patch.promotedAt : acceptedAt,
          mergeTurnMetadata(row.metadata_json, patch.metadata),
          tid,
          attemptId,
        );
        return updated.changes === 1 ? getTurnInput(this.db, tid) : null;
      })();
    },

    pendingTurnInputs(sessionId, ownerScope = null) {
      const owner = typeof ownerScope === "string" && ownerScope ? ownerScope : null;
      return this.db.all(
        `SELECT ti.* FROM turn_inputs ti
         WHERE ti.session_id = ?
           AND (? IS NULL OR ti.owner_scope = ?)
           AND ti.migration_status = ?
           AND ti.status = 'admitted' AND ti.delivery = 'queue'
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.session_id = ti.session_id
               AND m.turn_id = ti.turn_id
               AND m.role = 'assistant'
           )
         ORDER BY admitted_seq ASC`,
        String(sessionId || ""),
        owner,
        owner,
        TURN_INPUT_MIGRATION_OWNED,
      ).map(hydrateTurnInput).filter(
        (turn) => Boolean(recoverableQueueEnvelope(turn)),
      );
    },

    outcomeUnknownTurnInputs(sessionId, ownerScope = null) {
      const owner = typeof ownerScope === "string" && ownerScope ? ownerScope : null;
      return this.db.all(
        `SELECT ti.* FROM turn_inputs ti
         WHERE ti.session_id = ?
           AND (? IS NULL OR ti.owner_scope = ?)
           AND ti.migration_status = ?
           AND ti.status IN ('dispatching', 'outcome_unknown', 'promoted', 'accepted')
         ORDER BY admitted_seq DESC
         LIMIT 100`,
        String(sessionId || ""),
        owner,
        owner,
        TURN_INPUT_MIGRATION_OWNED,
      ).reverse().map(hydrateTurnInput);
    },
  };
}

module.exports = { createTurnDispatchStoreMethods };
