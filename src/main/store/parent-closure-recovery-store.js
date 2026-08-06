"use strict";

const crypto = require("node:crypto");

const MAX_SOURCE_BYTES = 96 * 1024;
const CLAIM_LEASE_MS = 2 * 60 * 1000;

function safeJson(value, fallback = {}) {
  try {
    const json = JSON.stringify(value && typeof value === "object" ? value : fallback);
    return Buffer.byteLength(json, "utf8") <= MAX_SOURCE_BYTES ? json : JSON.stringify(fallback);
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

function bounded(value, max = 512) {
  const text = String(value || "").trim();
  return text && text.length <= max && Buffer.byteLength(text, "utf8") <= max ? text : "";
}

function recoveryTurnIdFor(ownerScope, recoveryKey) {
  const digest = crypto.createHash("sha256")
    .update(`${ownerScope}\n${recoveryKey}`)
    .digest("hex")
    .slice(0, 32);
  return `turn_parent_closure_${digest}`;
}

function hydrate(row) {
  if (!row) return null;
  return Object.freeze({
    sessionId: row.session_id,
    ownerScope: row.owner_scope,
    sourceTurnId: row.source_turn_id,
    recoveryKey: row.recovery_key,
    recoveryTurnId: row.recovery_turn_id,
    status: row.status,
    source: parseJson(row.source_json),
    attemptCount: Number(row.attempt_count || 0),
    claimToken: row.claim_token || null,
    claimExpiresAt: row.claim_expires_at == null ? null : Number(row.claim_expires_at),
    claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
    dispatchedAt: row.dispatched_at == null ? null : Number(row.dispatched_at),
    updatedAt: Number(row.updated_at || 0),
    reason: row.reason || null,
  });
}

function validIdentity({ sessionId, ownerScope, sourceTurnId, recoveryKey } = {}) {
  return [sessionId, ownerScope, sourceTurnId, recoveryKey].every((value) => bounded(value));
}

function createParentClosureRecoveryStoreMethods() {
  return {
    prepareParentClosureRecovery({ sessionId, ownerScope, sourceTurnId, recoveryKey, source, now = Date.now() } = {}) {
      if (!validIdentity({ sessionId, ownerScope, sourceTurnId, recoveryKey }) || !source || typeof source !== "object") {
        return Object.freeze({ ok: false, reason: "INVALID_PARENT_CLOSURE", recovery: null });
      }
      const recoveryTurnId = recoveryTurnIdFor(ownerScope, recoveryKey);
      const sourceJson = safeJson(source);
      if (sourceJson === "{}") return Object.freeze({ ok: false, reason: "SOURCE_TOO_LARGE", recovery: null });
      const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      return this.db.transaction(() => {
        const existing = this.db.get(
          `SELECT * FROM parent_closure_recoveries
           WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
          sessionId, sourceTurnId, ownerScope,
        );
        if (existing) {
          const same = existing.recovery_key === recoveryKey
            && existing.recovery_turn_id === recoveryTurnId;
          return Object.freeze({
            ok: same,
            created: false,
            idempotent: same,
            reason: same ? null : "PARENT_CLOSURE_IMMUTABLE",
            recovery: hydrate(existing),
          });
        }
        this.db.run(
          `INSERT INTO parent_closure_recoveries
             (session_id, owner_scope, source_turn_id, recovery_key, recovery_turn_id,
              status, source_json, updated_at)
           VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`,
          sessionId, ownerScope, sourceTurnId, recoveryKey, recoveryTurnId, sourceJson, timestamp,
        );
        return Object.freeze({
          ok: true,
          created: true,
          idempotent: false,
          reason: null,
          recovery: hydrate(this.db.get(
            `SELECT * FROM parent_closure_recoveries
             WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
            sessionId, sourceTurnId, ownerScope,
          )),
        });
      })();
    },

    claimParentClosureRecovery({ sessionId, ownerScope, sourceTurnId, recoveryKey, now = Date.now() } = {}) {
      if (!validIdentity({ sessionId, ownerScope, sourceTurnId, recoveryKey })) {
        return Object.freeze({ ok: false, reason: "INVALID_PARENT_CLOSURE", recovery: null });
      }
      const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      return this.db.transaction(() => {
        const row = this.db.get(
          `SELECT * FROM parent_closure_recoveries
           WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
          sessionId, sourceTurnId, ownerScope,
        );
        if (!row) return Object.freeze({ ok: false, reason: "NOT_FOUND", recovery: null });
        if (row.recovery_key !== recoveryKey) return Object.freeze({ ok: false, reason: "KEY_MISMATCH", recovery: hydrate(row) });
        if (row.status === "dispatched") return Object.freeze({ ok: false, reason: "ALREADY_DISPATCHED", recovery: hydrate(row) });
        if (row.status === "unavailable") return Object.freeze({ ok: false, reason: "ALREADY_UNAVAILABLE", recovery: hydrate(row) });
        if (row.status === "claimed" && Number(row.claim_expires_at || 0) > timestamp) {
          return Object.freeze({ ok: false, reason: "ALREADY_CLAIMED", recovery: hydrate(row) });
        }
        const claimToken = crypto.randomUUID();
        const updated = this.db.run(
          `UPDATE parent_closure_recoveries
           SET status = 'claimed', attempt_count = attempt_count + 1,
               claim_token = ?, claim_expires_at = ?, claimed_at = ?, updated_at = ?, reason = NULL
           WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?
             AND recovery_key = ? AND status IN ('prepared', 'claimed')
             AND (status = 'prepared' OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
          claimToken, timestamp + CLAIM_LEASE_MS, timestamp, timestamp,
          sessionId, sourceTurnId, ownerScope, recoveryKey, timestamp,
        );
        if (updated.changes !== 1) {
          const raced = this.db.get(
            `SELECT * FROM parent_closure_recoveries
             WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
            sessionId, sourceTurnId, ownerScope,
          );
          return Object.freeze({ ok: false, reason: raced?.status === "dispatched" ? "ALREADY_DISPATCHED" : "ALREADY_CLAIMED", recovery: hydrate(raced) });
        }
        return Object.freeze({
          ok: true,
          claimed: true,
          reason: null,
          claimToken,
          recovery: hydrate(this.db.get(
            `SELECT * FROM parent_closure_recoveries
             WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
            sessionId, sourceTurnId, ownerScope,
          )),
        });
      })();
    },

    markParentClosureRecoveryDispatched({ sessionId, ownerScope, sourceTurnId, recoveryKey, recoveryTurnId, claimToken, now = Date.now() } = {}) {
      return this._finishParentClosureRecovery({
        sessionId, ownerScope, sourceTurnId, recoveryKey, recoveryTurnId, claimToken,
        status: "dispatched", field: "dispatched_at", now,
      });
    },

    markParentClosureRecoveryUnavailable({ sessionId, ownerScope, sourceTurnId, recoveryKey, claimToken, reason = "DISPATCH_FAILED", now = Date.now() } = {}) {
      return this._finishParentClosureRecovery({
        sessionId, ownerScope, sourceTurnId, recoveryKey, claimToken,
        status: "unavailable", reason, now,
      });
    },

    _finishParentClosureRecovery({ sessionId, ownerScope, sourceTurnId, recoveryKey, recoveryTurnId, claimToken, status, field, reason = null, now = Date.now() } = {}) {
      if (!validIdentity({ sessionId, ownerScope, sourceTurnId, recoveryKey })
        || !bounded(claimToken)
        || !["dispatched", "unavailable"].includes(status)) {
        return Object.freeze({ ok: false, reason: "INVALID_PARENT_CLOSURE", recovery: null });
      }
      const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      return this.db.transaction(() => {
        const row = this.db.get(
          `SELECT * FROM parent_closure_recoveries
           WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
          sessionId, sourceTurnId, ownerScope,
        );
        if (!row) return Object.freeze({ ok: false, reason: "NOT_FOUND", recovery: null });
        if (row.status === status) return Object.freeze({ ok: true, idempotent: true, recovery: hydrate(row) });
        const updated = this.db.run(
          `UPDATE parent_closure_recoveries
           SET status = ?, ${field || "dispatched_at"} = ?, claim_expires_at = NULL,
               updated_at = ?, reason = ?
           WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?
             AND recovery_key = ? AND status = 'claimed'
             AND claim_token = ?${status === "dispatched" ? " AND recovery_turn_id = ?" : ""}`,
          status, timestamp, timestamp, reason,
          sessionId, sourceTurnId, ownerScope, recoveryKey, claimToken,
          ...(status === "dispatched" ? [recoveryTurnId] : []),
        );
        const current = this.db.get(
          `SELECT * FROM parent_closure_recoveries
           WHERE session_id = ? AND source_turn_id = ? AND owner_scope = ?`,
          sessionId, sourceTurnId, ownerScope,
        );
        return Object.freeze({
          ok: updated.changes === 1 || current?.status === status,
          idempotent: updated.changes !== 1 && current?.status === status,
          reason: updated.changes === 1 || current?.status === status ? null : "CLAIM_TOKEN_MISMATCH",
          recovery: hydrate(current),
        });
      })();
    },

    getParentClosureRecovery(sessionId, sourceTurnId, ownerScope = null) {
      if (!sessionId || !sourceTurnId) return null;
      const row = this.db.get(
        `SELECT * FROM parent_closure_recoveries
         WHERE session_id = ? AND source_turn_id = ?
           AND (? IS NULL OR owner_scope = ?)`,
        String(sessionId), String(sourceTurnId), ownerScope, ownerScope,
      );
      return hydrate(row);
    },

    listPendingParentClosureRecoveries(sessionId, ownerScope = null, now = Date.now()) {
      if (!sessionId) return [];
      const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      return this.db.all(
        `SELECT * FROM parent_closure_recoveries
         WHERE session_id = ? AND (? IS NULL OR owner_scope = ?)
           AND (status = 'prepared' OR (status = 'claimed' AND claim_expires_at <= ?))
         ORDER BY updated_at, source_turn_id`,
        String(sessionId), ownerScope, ownerScope, timestamp,
      ).map(hydrate);
    },
  };
}

module.exports = {
  CLAIM_LEASE_MS,
  createParentClosureRecoveryStoreMethods,
  recoveryTurnIdFor,
};
