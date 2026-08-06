"use strict";

const { TURN_INPUT_MIGRATION_OWNED } = require("./turn-admission-migration");

const MAX_TASK_CORE_BYTES = 128 * 1024;

function boundedTaskCore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!json || Buffer.byteLength(json, "utf8") > MAX_TASK_CORE_BYTES) return null;
  return { json, value };
}

function createTurnTaskCoreStoreMethods({ hydrateTurnInput }) {
  return {
    persistTurnTaskCore({ sessionId, turnId, ownerScope, taskCore } = {}) {
      const sid = typeof sessionId === "string" ? sessionId : "";
      const tid = typeof turnId === "string" ? turnId : "";
      const owner = typeof ownerScope === "string" ? ownerScope : "";
      const bounded = boundedTaskCore(taskCore);
      const fingerprint = typeof taskCore?.fingerprint === "string" ? taskCore.fingerprint : "";
      if (!sid || !tid || !owner || !bounded || !fingerprint) {
        return Object.freeze({ ok: false, reason: "INVALID_TASK_CORE", turn: null });
      }
      return this.db.transaction(() => {
        const row = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE session_id = ? AND turn_id = ? AND owner_scope = ?
             AND migration_status = ?`,
          sid,
          tid,
          owner,
          TURN_INPUT_MIGRATION_OWNED,
        );
        if (!row) return Object.freeze({ ok: false, reason: "NOT_FOUND", turn: null });
        if (row.task_core_json != null) {
          const same = row.task_core_fingerprint === fingerprint && row.task_core_json === bounded.json;
          return Object.freeze({
            ok: same,
            idempotent: same,
            immutable: true,
            reason: same ? null : "TASK_CORE_IMMUTABLE",
            turn: hydrateTurnInput(row),
          });
        }
        const updated = this.db.run(
          `UPDATE turn_inputs
           SET task_core_json = ?, task_core_fingerprint = ?
           WHERE session_id = ? AND turn_id = ? AND owner_scope = ?
             AND migration_status = ? AND task_core_json IS NULL`,
          bounded.json,
          fingerprint,
          sid,
          tid,
          owner,
          TURN_INPUT_MIGRATION_OWNED,
        );
        const saved = this.db.get(
          `SELECT * FROM turn_inputs
           WHERE session_id = ? AND turn_id = ? AND owner_scope = ?
             AND migration_status = ?`,
          sid,
          tid,
          owner,
          TURN_INPUT_MIGRATION_OWNED,
        );
        return Object.freeze({
          ok: updated.changes === 1,
          immutable: true,
          reason: updated.changes === 1 ? null : "TASK_CORE_CAS_LOST",
          turn: saved ? hydrateTurnInput(saved) : null,
        });
      })();
    },
  };
}

module.exports = { MAX_TASK_CORE_BYTES, createTurnTaskCoreStoreMethods };
