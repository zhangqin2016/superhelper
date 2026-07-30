"use strict";

const {
  TURN_INPUT_MIGRATION_OWNED,
} = require("./turn-admission-migration");

const CLAIMABLE_TURN_STATUSES = new Set([
  "admitted",
  "dispatching",
  "outcome_unknown",
  "promoted",
  "accepted",
]);
const OUTCOME_UNKNOWN_TURN_STATUSES = new Set([
  "dispatching",
  "outcome_unknown",
  "promoted",
  "accepted",
]);
const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

function boundedIdentity(value) {
  if (typeof value !== "string" || !value || value.length > 512) return null;
  return Buffer.byteLength(value, "utf8") <= 512 ? value : null;
}

function terminalStatus(terminalType) {
  if (terminalType === "turn.completed") return "completed";
  if (terminalType === "turn.interrupted") return "interrupted";
  if (terminalType === "turn.failed" || terminalType === "turn.stalled") {
    return "failed";
  }
  return null;
}

function createTurnTerminalStoreMethods({
  hydrateTurnInput,
  mergeTurnMetadata,
}) {
  return {
    markTurnInputTerminal(claim = {}, terminalType, patch = {}) {
      const ownerScope = boundedIdentity(claim.ownerScope);
      const sessionId = boundedIdentity(claim.sessionId);
      const turnId = boundedIdentity(claim.turnId);
      const dispatchAttemptId = claim.dispatchAttemptId == null
        ? null
        : boundedIdentity(claim.dispatchAttemptId);
      const status = terminalStatus(terminalType);
      const fromStatuses = Array.isArray(claim.fromStatuses)
        ? [...new Set(claim.fromStatuses)].filter(
            (value) => CLAIMABLE_TURN_STATUSES.has(value),
          )
        : [];
      if (
        !ownerScope
        || !sessionId
        || !turnId
        || !status
        || !fromStatuses.length
        || (claim.dispatchAttemptId != null && !dispatchAttemptId)
      ) {
        return Object.freeze({
          ok: false,
          reason: "INVALID_TERMINAL_CLAIM",
          outcomeUnknown: false,
          turn: null,
        });
      }
      return this.db.transaction(() => {
        const row = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE owner_scope = ? AND session_id = ? AND turn_id = ?
             AND migration_status = ?`,
          ownerScope,
          sessionId,
          turnId,
          TURN_INPUT_MIGRATION_OWNED,
        );
        if (!row) {
          return Object.freeze({
            ok: false,
            reason: "NOT_FOUND",
            outcomeUnknown: false,
            turn: null,
          });
        }
        const current = hydrateTurnInput(row);
        if (row.terminal_at != null || TERMINAL_TURN_STATUSES.has(row.status)) {
          return Object.freeze({
            ok: false,
            reason: "TERMINAL_IMMUTABLE",
            outcomeUnknown: false,
            turn: current,
          });
        }
        if (
          !fromStatuses.includes(row.status)
          || row.dispatch_attempt_id !== dispatchAttemptId
        ) {
          return Object.freeze({
            ok: false,
            reason: "TERMINAL_CLAIM_MISMATCH",
            outcomeUnknown: OUTCOME_UNKNOWN_TURN_STATUSES.has(row.status),
            turn: current,
          });
        }
        const placeholders = fromStatuses.map(() => "?").join(", ");
        const updated = this.db.run(
          `UPDATE turn_inputs
           SET status = ?, terminal_at = ?, terminal_type = ?,
               error_code = ?, metadata_json = ?
           WHERE owner_scope = ? AND session_id = ? AND turn_id = ?
             AND migration_status = ? AND terminal_at IS NULL
             AND status IN (${placeholders})
             AND dispatch_attempt_id IS ?`,
          status,
          Number.isFinite(patch.terminalAt) ? patch.terminalAt : Date.now(),
          terminalType,
          patch.errorCode || patch.code || null,
          mergeTurnMetadata(row.metadata_json, patch.metadata),
          ownerScope,
          sessionId,
          turnId,
          TURN_INPUT_MIGRATION_OWNED,
          ...fromStatuses,
          dispatchAttemptId,
        );
        if (updated.changes !== 1) {
          const raced = this.db.get(
            `SELECT * FROM turn_inputs
             WHERE owner_scope = ? AND session_id = ? AND turn_id = ?
               AND migration_status = ?`,
            ownerScope,
            sessionId,
            turnId,
            TURN_INPUT_MIGRATION_OWNED,
          );
          return Object.freeze({
            ok: false,
            reason: "TERMINAL_CAS_LOST",
            outcomeUnknown: OUTCOME_UNKNOWN_TURN_STATUSES.has(raced?.status),
            turn: raced ? hydrateTurnInput(raced) : null,
          });
        }
        const terminal = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE owner_scope = ? AND session_id = ? AND turn_id = ?
             AND migration_status = ?`,
          ownerScope,
          sessionId,
          turnId,
          TURN_INPUT_MIGRATION_OWNED,
        );
        return Object.freeze({
          ok: true,
          reason: null,
          outcomeUnknown: false,
          turn: terminal ? hydrateTurnInput(terminal) : null,
        });
      })();
    },
  };
}

module.exports = {
  CLAIMABLE_TURN_STATUSES,
  OUTCOME_UNKNOWN_TURN_STATUSES,
  TERMINAL_TURN_STATUSES,
  createTurnTerminalStoreMethods,
};
