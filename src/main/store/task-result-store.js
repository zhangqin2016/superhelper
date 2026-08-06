"use strict";

const MAX_RESULT_BYTES = 64 * 1024;

function safeJson(value) {
  try {
    const json = JSON.stringify(value && typeof value === "object" ? value : {});
    return Buffer.byteLength(json, "utf8") <= MAX_RESULT_BYTES ? json : "{}";
  } catch {
    return "{}";
  }
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function hydrate(row) {
  if (!row) return null;
  return Object.freeze({
    sessionId: row.session_id,
    ownerScope: row.owner_scope,
    taskId: row.task_id,
    turnId: row.turn_id,
    attemptId: row.attempt_id || null,
    terminalType: row.terminal_type,
    verification: parseJson(row.verification_json),
    deliveryStatus: row.delivery_status,
    delivery: parseJson(row.delivery_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function createTaskResultStoreMethods() {
  return {
    persistTaskResult({
      sessionId,
      ownerScope,
      taskId,
      turnId,
      attemptId = null,
      terminalType,
      verification = {},
    } = {}) {
      if (!sessionId || !ownerScope || !taskId || !turnId || !terminalType) {
        return Object.freeze({ ok: false, reason: "INVALID_TASK_RESULT", result: null });
      }
      const verificationJson = safeJson(verification);
      return this.db.transaction(() => {
        const existing = this.db.get(
          `SELECT * FROM task_results
           WHERE session_id = ? AND owner_scope = ? AND turn_id = ?`,
          sessionId,
          ownerScope,
          turnId,
        );
        if (existing) {
          const same = existing.task_id === taskId
            && existing.terminal_type === terminalType
            && existing.verification_json === verificationJson;
          return Object.freeze({
            ok: same,
            idempotent: same,
            reason: same ? null : "TASK_RESULT_IMMUTABLE",
            result: hydrate(existing),
          });
        }
        const now = Date.now();
        this.db.run(
          `INSERT INTO task_results
             (session_id, owner_scope, task_id, turn_id, attempt_id,
              terminal_type, verification_json, delivery_status, delivery_json,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?, ?)`,
          sessionId,
          ownerScope,
          taskId,
          turnId,
          attemptId,
          terminalType,
          verificationJson,
          now,
          now,
        );
        return Object.freeze({
          ok: true,
          idempotent: false,
          reason: null,
          result: hydrate(this.db.get(
            `SELECT * FROM task_results WHERE session_id = ? AND turn_id = ?`,
            sessionId,
            turnId,
          )),
        });
      })();
    },

    markTaskResultDelivered({ sessionId, ownerScope, turnId, delivery = {} } = {}) {
      if (!sessionId || !ownerScope || !turnId) {
        return Object.freeze({ ok: false, reason: "INVALID_DELIVERY", result: null });
      }
      const deliveryJson = safeJson(delivery);
      return this.db.transaction(() => {
        const updated = this.db.run(
          `UPDATE task_results
           SET delivery_status = 'delivered', delivery_json = ?, updated_at = ?
           WHERE session_id = ? AND owner_scope = ? AND turn_id = ?
             AND delivery_status <> 'delivered'`,
          deliveryJson,
          Date.now(),
          sessionId,
          ownerScope,
          turnId,
        );
        const row = this.db.get(
          `SELECT * FROM task_results WHERE session_id = ? AND owner_scope = ? AND turn_id = ?`,
          sessionId,
          ownerScope,
          turnId,
        );
        return Object.freeze({
          ok: updated.changes === 1 || row?.delivery_status === "delivered",
          idempotent: updated.changes !== 1 && row?.delivery_status === "delivered",
          reason: row ? null : "NOT_FOUND",
          result: hydrate(row),
        });
      })();
    },

    getTaskResult(sessionId, ownerScope, turnId) {
      if (!sessionId || !ownerScope || !turnId) return null;
      return hydrate(this.db.get(
        `SELECT * FROM task_results WHERE session_id = ? AND owner_scope = ? AND turn_id = ?`,
        sessionId,
        ownerScope,
        turnId,
      ));
    },
  };
}

module.exports = { createTaskResultStoreMethods };
