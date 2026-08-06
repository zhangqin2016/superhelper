"use strict";

const MAX_JSON_BYTES = 64 * 1024;

const TERMINAL_STATUSES = new Set(["delivered", "failed", "cancelled"]);
const VERIFICATION_STATUSES = new Set(["verified", "observed", "unverified", "blocked", "not_required"]);
const TRANSITIONS = new Map([
  ["admitted", new Set(["running", "waiting_user", "failed", "cancelled", "outcome_unknown"])],
  ["running", new Set(["waiting_user", "verifying", "failed", "cancelled", "outcome_unknown"])],
  ["waiting_user", new Set(["running", "failed", "cancelled"])],
  ["outcome_unknown", new Set(["running", "failed", "cancelled"])],
  ["verifying", new Set(["verified", "observed", "unverified", "blocked", "not_required", "failed", "outcome_unknown"])],
  ["verified", new Set(["delivered"])],
  ["observed", new Set(["delivered"])],
  ["unverified", new Set(["delivered"])],
  ["blocked", new Set(["delivered"])],
  ["not_required", new Set(["delivered"])],
  ["delivered", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()],
]);

function safeJson(value, fallback = {}) {
  try {
    const json = JSON.stringify(value && typeof value === "object" ? value : fallback);
    return Buffer.byteLength(json, "utf8") <= MAX_JSON_BYTES ? json : JSON.stringify(fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function bounded(value, max = 240) {
  const text = String(value || "").trim();
  return text.length <= max ? text : text.slice(0, max);
}

function hydrate(row) {
  if (!row) return null;
  return Object.freeze({
    sessionId: row.session_id,
    ownerScope: row.owner_scope,
    taskId: row.task_id,
    turnId: row.turn_id,
    status: row.status,
    deliveryStatus: row.delivery_status || "pending",
    version: Number(row.version || 0),
    graphId: row.graph_id || "",
    attemptId: row.attempt_id || "",
    checkpointId: row.checkpoint_id || "",
    processJobId: row.process_job_id || "",
    taskCoreFingerprint: row.task_core_fingerprint || "",
    verification: parseJson(row.verification_json),
    delivery: parseJson(row.delivery_json),
    metadata: parseJson(row.metadata_json),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  });
}

function validateIdentity({ sessionId, ownerScope, taskId, turnId } = {}) {
  return [sessionId, ownerScope, taskId, turnId].every((value) => (
    typeof value === "string" && value.trim() && value.length <= 240
  ));
}

function migrateTaskLifecycleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_lifecycles (
      session_id            TEXT NOT NULL,
      owner_scope           TEXT NOT NULL,
      task_id               TEXT NOT NULL,
      turn_id               TEXT NOT NULL,
      status                TEXT NOT NULL,
      delivery_status      TEXT NOT NULL DEFAULT 'pending',
      version               INTEGER NOT NULL,
      graph_id              TEXT NOT NULL DEFAULT '',
      attempt_id            TEXT NOT NULL DEFAULT '',
      checkpoint_id         TEXT NOT NULL DEFAULT '',
      process_job_id       TEXT NOT NULL DEFAULT '',
      task_core_fingerprint TEXT NOT NULL DEFAULT '',
      verification_json     TEXT NOT NULL DEFAULT '{}',
      delivery_json         TEXT NOT NULL DEFAULT '{}',
      metadata_json         TEXT NOT NULL DEFAULT '{}',
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_id),
      UNIQUE (owner_scope, task_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_lifecycles_owner_status
      ON task_lifecycles(owner_scope, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_lifecycles_graph
      ON task_lifecycles(owner_scope, graph_id, updated_at);
  `);
  try {
    db.exec("ALTER TABLE task_lifecycles ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'");
  } catch {
    // Existing installs created during the first lifecycle migration already
    // have the column; SQLite has no IF NOT EXISTS for ADD COLUMN.
  }
  try { db.exec("ALTER TABLE task_lifecycles ADD COLUMN process_job_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
}

function createTaskLifecycleStoreMethods() {
  return {
    ensureTaskLifecycle({
      sessionId,
      ownerScope,
      taskId,
      turnId,
          status = "admitted",
      taskCoreFingerprint = "",
      graphId = "",
      attemptId = "",
      metadata = {},
      now = Date.now(),
    } = {}) {
      if (!validateIdentity({ sessionId, ownerScope, taskId, turnId }) || !TRANSITIONS.has(status)) {
        return Object.freeze({ ok: false, reason: "INVALID_TASK_LIFECYCLE", lifecycle: null });
      }
      return this.db.transaction(() => {
        const existing = this.db.get(
          `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
          sessionId, ownerScope, turnId,
        );
        if (existing) {
          const same = existing.task_id === taskId
            && existing.task_core_fingerprint === bounded(taskCoreFingerprint)
            && existing.graph_id === bounded(graphId)
            && existing.attempt_id === bounded(attemptId);
          return Object.freeze({
            ok: same,
            idempotent: same,
            reason: same ? null : "TASK_LIFECYCLE_IMMUTABLE",
            lifecycle: hydrate(existing),
          });
        }
        const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        this.db.run(
          `INSERT INTO task_lifecycles
             (session_id, owner_scope, task_id, turn_id, status, delivery_status, version,
              graph_id, attempt_id, checkpoint_id, process_job_id, task_core_fingerprint,
              verification_json, delivery_json, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, '', '', ?, '{}', '{}', ?, ?, ?)`,
          sessionId, ownerScope, taskId, turnId, status,
          bounded(graphId), bounded(attemptId), bounded(taskCoreFingerprint),
          safeJson(metadata), timestamp, timestamp,
        );
        return Object.freeze({
          ok: true,
          idempotent: false,
          reason: null,
          lifecycle: hydrate(this.db.get(
            `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
            sessionId, ownerScope, turnId,
          )),
        });
      })();
    },

    transitionTaskLifecycle({
      sessionId,
      ownerScope,
      taskId,
      turnId,
      fromStatuses = [],
      status,
      expectedVersion = null,
      graphId,
      attemptId,
      checkpointId,
      processJobId,
      taskCoreFingerprint,
      verification,
      delivery,
      metadata,
      now = Date.now(),
    } = {}) {
      if (!validateIdentity({ sessionId, ownerScope, taskId, turnId }) || !TRANSITIONS.has(status)) {
        return Object.freeze({ ok: false, reason: "INVALID_TASK_LIFECYCLE", lifecycle: null });
      }
      if (status === "verified" || status === "observed" || status === "unverified" || status === "blocked" || status === "not_required") {
        if (verification && typeof verification === "object" && verification.status && verification.status !== status) {
          return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_VERIFICATION_MISMATCH", lifecycle: null });
        }
      }
      return this.db.transaction(() => {
        const existing = this.db.get(
          `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
          sessionId, ownerScope, turnId,
        );
        if (!existing) return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_NOT_FOUND", lifecycle: null });
        if (existing.task_id !== taskId) return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_IDENTITY_CONFLICT", lifecycle: hydrate(existing) });
        if (expectedVersion != null && Number(existing.version) !== Number(expectedVersion)) {
          return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_VERSION_CONFLICT", lifecycle: hydrate(existing) });
        }
        const allowedFrom = Array.isArray(fromStatuses) && fromStatuses.length
          ? fromStatuses.map(String)
          : [existing.status];
        if (!allowedFrom.includes(existing.status)) {
          return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_STATUS_CONFLICT", lifecycle: hydrate(existing) });
        }
        if (!TRANSITIONS.get(existing.status)?.has(status) && existing.status !== status) {
          return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_TRANSITION_INVALID", lifecycle: hydrate(existing) });
        }
        const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        const nextVersion = Number(existing.version) + 1;
        const nextVerification = verification === undefined ? existing.verification_json : safeJson(verification);
        const nextDelivery = delivery === undefined ? existing.delivery_json : safeJson(delivery);
        const nextMetadata = metadata === undefined ? existing.metadata_json : safeJson(metadata);
        const updated = this.db.run(
          `UPDATE task_lifecycles SET status=?, delivery_status=?, version=?, graph_id=?, attempt_id=?,
             checkpoint_id=?, process_job_id=?, task_core_fingerprint=?, verification_json=?,
             delivery_json=?, metadata_json=?, updated_at=?
           WHERE session_id=? AND owner_scope=? AND turn_id=? AND version=?`,
          status,
          status === "delivered" ? "delivered" : existing.delivery_status,
          nextVersion,
          graphId === undefined ? existing.graph_id : bounded(graphId),
          attemptId === undefined ? existing.attempt_id : bounded(attemptId),
          checkpointId === undefined ? existing.checkpoint_id : bounded(checkpointId),
          processJobId === undefined ? existing.process_job_id : bounded(processJobId),
          taskCoreFingerprint === undefined ? existing.task_core_fingerprint : bounded(taskCoreFingerprint),
          nextVerification,
          nextDelivery,
          nextMetadata,
          timestamp,
          sessionId,
          ownerScope,
          turnId,
          existing.version,
        );
        if (Number(updated.changes || 0) !== 1) {
          return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_VERSION_CONFLICT", lifecycle: hydrate(this.db.get(
            `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
            sessionId, ownerScope, turnId,
          )) });
        }
        return Object.freeze({ ok: true, idempotent: false, reason: null, lifecycle: hydrate(this.db.get(
          `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
          sessionId, ownerScope, turnId,
        )) });
      })();
    },

    markTaskLifecycleDelivered({
      sessionId,
      ownerScope,
      taskId,
      turnId,
      delivery = {},
      now = Date.now(),
    } = {}) {
      if (!validateIdentity({ sessionId, ownerScope, taskId, turnId })) {
        return Object.freeze({ ok: false, reason: "INVALID_TASK_LIFECYCLE", lifecycle: null });
      }
      return this.db.transaction(() => {
        const existing = this.db.get(
          `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
          sessionId, ownerScope, turnId,
        );
        if (!existing) return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_NOT_FOUND", lifecycle: null });
        if (existing.task_id !== taskId) return Object.freeze({ ok: false, reason: "TASK_LIFECYCLE_IDENTITY_CONFLICT", lifecycle: hydrate(existing) });
        if (existing.delivery_status === "delivered") {
          return Object.freeze({ ok: true, idempotent: true, reason: null, lifecycle: hydrate(existing) });
        }
        const updated = this.db.run(
          `UPDATE task_lifecycles SET delivery_status='delivered', delivery_json=?, updated_at=?
           WHERE session_id=? AND owner_scope=? AND turn_id=? AND delivery_status='pending'`,
          safeJson(delivery),
          Number.isFinite(Number(now)) ? Number(now) : Date.now(),
          sessionId,
          ownerScope,
          turnId,
        );
        const row = this.db.get(
          `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
          sessionId, ownerScope, turnId,
        );
        return Object.freeze({ ok: Number(updated.changes || 0) === 1, idempotent: false, reason: null, lifecycle: hydrate(row) });
      })();
    },

    getTaskLifecycle(sessionId, ownerScope, turnId) {
      if (!sessionId || !ownerScope || !turnId) return null;
      return hydrate(this.db.get(
        `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? AND turn_id=?`,
        sessionId, ownerScope, turnId,
      ));
    },

    listTaskLifecycles(sessionId, ownerScope, { limit = 100, activeOnly = false } = {}) {
      if (!sessionId || !ownerScope) return [];
      const statuses = activeOnly ? [...TERMINAL_STATUSES] : [];
      const predicate = activeOnly ? `AND status NOT IN (${statuses.map(() => "?").join(",")})` : "";
      const params = [sessionId, ownerScope, ...statuses, Math.max(1, Math.min(Number(limit) || 100, 500))];
      return this.db.all(
        `SELECT * FROM task_lifecycles WHERE session_id=? AND owner_scope=? ${predicate}
         ORDER BY updated_at DESC, turn_id DESC LIMIT ?`,
        ...params,
      ).map(hydrate);
    },
  };
}

module.exports = {
  TERMINAL_STATUSES,
  TRANSITIONS,
  createTaskLifecycleStoreMethods,
  migrateTaskLifecycleSchema,
};
