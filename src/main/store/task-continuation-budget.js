"use strict";

const { normalizeQueueRecoveryEnvelope } = require("../turn-queue-recovery-envelope");
const { MAX_CHARACTER_BINDING_BYTES } = require("../character-worlds/constants");

// Claims are reserved before dispatch and never refunded: an uncertain send may
// already have effects. Each original source gets at most 8 automatic claims,
// within 24 hours measured from its FIRST reservation, not source creation.
// Retries of the same admission reuse its claim; user turns start a new root.
const MAX_ROUNDS = 8;
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRESS_KEYS = 128;
const MAX_SOURCE_ANCESTORS = 128;

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_continuation_roots (
    turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_scope TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_continuation_sources (
    continuation_turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    owner_scope TEXT NOT NULL, source_turn_id TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_continuation_claims (
    continuation_turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_scope TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    root_turn_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    root_started_at INTEGER NOT NULL,
    reserved_at INTEGER NOT NULL,
    progress_keys_json TEXT NOT NULL,
    UNIQUE (owner_scope, session_id, root_turn_id, round)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_continuation_cancellations (
    session_id TEXT NOT NULL, owner_scope TEXT NOT NULL, cancelled_at INTEGER NOT NULL,
    preserved_turn_id TEXT,
    PRIMARY KEY (owner_scope, session_id)
  )`);
}

function cancelled(row) {
  return row && (row.status === "interrupted" || row.status === "cancelled"
    || row.terminal_type === "turn.interrupted" || row.terminal_type === "turn.cancelled");
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value.trim() === value;
}

// Only called from the first durable admission, never from editable metadata.
function recordTaskContinuationSource(db, { sessionId, ownerScope, sourceTurnId, continuationTurnId, newTaskAttempt = false }) {
  ensureSchema(db);
  db.run(`INSERT INTO task_continuation_sources
    (continuation_turn_id, session_id, owner_scope, source_turn_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (continuation_turn_id) DO NOTHING`, continuationTurnId, sessionId, ownerScope, sourceTurnId);
  const row = db.get("SELECT * FROM task_continuation_sources WHERE continuation_turn_id = ?", continuationTurnId);
  if (row.session_id !== sessionId || row.owner_scope !== ownerScope || row.source_turn_id !== sourceTurnId) {
    throw new Error("TASK_CONTINUATION_IDENTITY_CONFLICT");
  }
  if (newTaskAttempt === true) {
    const source = db.get(`SELECT 1 FROM turn_inputs WHERE turn_id=? AND session_id=?
      AND owner_scope=? AND migration_status='owned'`, sourceTurnId, sessionId, ownerScope);
    const claim = db.get("SELECT 1 FROM task_continuation_claims WHERE continuation_turn_id=?", continuationTurnId);
    if (!source || claim) throw new Error("TASK_CONTINUATION_IDENTITY_CONFLICT");
    db.run(`INSERT INTO task_continuation_roots (turn_id, session_id, owner_scope) VALUES (?, ?, ?)`,
      continuationTurnId, sessionId, ownerScope);
  }
  return { ok: true };
}

// A user stop also fences jobs whose source already completed and has not yet
// made any automatic claim. This does not terminate the underlying OS process.
function cancelTaskContinuations(db, input = {}) {
  const { sessionId, ownerScope } = input;
  const now = input.now === undefined ? Date.now() : input.now;
  if (![sessionId, ownerScope].every(validId) || !Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "TASK_CONTINUATION_INVALID_INPUT" };
  }
  ensureSchema(db);
  return db.transaction(() => {
    let preservedTurnId = null;
    if (validId(input.preservedTurnId)) {
      const source = resolveRoot(db, sessionId, ownerScope, input.preservedTurnId);
      if (!source.reason && source.rootTurnId === input.preservedTurnId) preservedTurnId = input.preservedTurnId;
    }
    db.run(`INSERT INTO task_continuation_cancellations (session_id, owner_scope, cancelled_at, preserved_turn_id)
      VALUES (?, ?, ?, ?) ON CONFLICT (owner_scope, session_id) DO UPDATE SET
      preserved_turn_id = CASE WHEN excluded.cancelled_at >= cancelled_at THEN excluded.preserved_turn_id ELSE preserved_turn_id END,
      cancelled_at = MAX(cancelled_at, excluded.cancelled_at)`, sessionId, ownerScope, now, preservedTurnId);
    const fence = db.get(`SELECT cancelled_at, preserved_turn_id FROM task_continuation_cancellations
      WHERE session_id = ? AND owner_scope = ?`, sessionId, ownerScope);
    return { ok: true, cancelledAt: fence.cancelled_at };
  })();
}

function resolveRoot(db, sessionId, ownerScope, sourceTurnId) {
  const visited = new Set();
  let current = sourceTurnId;
  let claimedRoot = null;
  while (visited.size < MAX_SOURCE_ANCESTORS) {
    if (!validId(current) || visited.has(current)) return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
    visited.add(current);
    const row = db.get(`SELECT * FROM turn_inputs WHERE turn_id = ? AND session_id = ?
      AND owner_scope = ? AND migration_status = 'owned'`, current, sessionId, ownerScope);
    if (!row) return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
    if (cancelled(row)) return { reason: "TASK_CONTINUATION_CANCELLED" };
    const claim = db.get("SELECT * FROM task_continuation_claims WHERE continuation_turn_id = ?", current);
    if (claim) {
      if (claim.session_id !== sessionId || claim.owner_scope !== ownerScope
        || (claimedRoot && claim.root_turn_id !== claimedRoot)) {
        return { reason: "TASK_CONTINUATION_IDENTITY_CONFLICT" };
      }
      claimedRoot = claim.root_turn_id;
      current = claim.source_turn_id;
      continue;
    }
    // Only explicit user retry at first host admission creates this boundary.
    // Keep the separate source link for requirements/persona inheritance, but
    // never infer renewed authorization from editable metadata or model text.
    const root = db.get("SELECT * FROM task_continuation_roots WHERE turn_id = ?", current);
    if (root) {
      if (root.session_id !== sessionId || root.owner_scope !== ownerScope
        || (claimedRoot && claimedRoot !== current)) return { reason: "TASK_CONTINUATION_IDENTITY_CONFLICT" };
      return { rootTurnId: current, rootCreatedAt: row.created_at };
    }
    const direct = db.get("SELECT * FROM task_continuation_sources WHERE continuation_turn_id = ?", current);
    if (direct) {
      if (direct.session_id !== sessionId || direct.owner_scope !== ownerScope) {
        return { reason: "TASK_CONTINUATION_IDENTITY_CONFLICT" };
      }
      current = direct.source_turn_id;
      continue;
    }
    // serializeTurnMetadata strips caller queueRecovery and persists only the
    // host admission envelope. Never infer ancestry from user/task text or from
    // arbitrary metadata.sourceTurnId. Malformed protected metadata cannot mint
    // a fresh root; validate the same envelope used by durable queue recovery.
    let metadata;
    try {
      const raw = row.metadata_json ?? "{}";
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CHARACTER_BINDING_BYTES) {
        return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
      }
      metadata = JSON.parse(raw);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata");
    } catch { return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" }; }
    if (Object.hasOwn(metadata, "queueRecovery")) {
      const envelope = normalizeQueueRecoveryEnvelope(metadata.queueRecovery);
      if (!envelope) return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
      const parent = envelope.options.sourceTurnId;
      if (validId(parent)) {
        current = parent;
        continue;
      }
      if ((parent !== null && parent !== undefined && parent !== "") || envelope.options.recordUser === false) {
        return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
      }
    }
    if (claimedRoot && claimedRoot !== current) return { reason: "TASK_CONTINUATION_IDENTITY_CONFLICT" };
    return { rootTurnId: claimedRoot || current, rootCreatedAt: row.created_at };
  }
  return { reason: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
}

function reserveTaskContinuation(db, input = {}) {
  const { sessionId, ownerScope, sourceTurnId, continuationTurnId, progressKeys = [] } = input;
  const now = input.now === undefined ? Date.now() : input.now;
  let rootTurnId = sourceTurnId || null;
  let rounds = 0;
  const deny = (reason) => ({ ok: false, reason, rootTurnId, rounds });
  if (![sessionId, ownerScope, sourceTurnId, continuationTurnId].every(validId)
    || !Number.isSafeInteger(now) || now < 0) {
    return deny("TASK_CONTINUATION_INVALID_INPUT");
  }
  if (sourceTurnId === continuationTurnId) return deny("TASK_CONTINUATION_IDENTITY_CONFLICT");
  ensureSchema(db);
  return db.transaction(() => {
    const ancestry = resolveRoot(db, sessionId, ownerScope, sourceTurnId);
    if (ancestry.reason) return deny(ancestry.reason);
    rootTurnId = ancestry.rootTurnId;
    const fence = db.get(`SELECT cancelled_at, preserved_turn_id FROM task_continuation_cancellations
      WHERE session_id = ? AND owner_scope = ?`, sessionId, ownerScope);
    if (fence) {
      if (!Number.isSafeInteger(ancestry.rootCreatedAt) || ancestry.rootCreatedAt < 0) {
        return deny("TASK_CONTINUATION_SOURCE_UNAVAILABLE");
      }
      if (ancestry.rootCreatedAt <= fence.cancelled_at && rootTurnId !== fence.preserved_turn_id) {
        return deny("TASK_CONTINUATION_CANCELLED");
      }
    }
    const stopped = db.get(`SELECT 1 FROM task_continuation_claims c
      JOIN turn_inputs t ON t.turn_id = c.continuation_turn_id
      AND t.session_id = c.session_id AND t.owner_scope = c.owner_scope
      WHERE c.session_id = ? AND c.owner_scope = ? AND c.root_turn_id = ?
      AND (t.status IN ('interrupted', 'cancelled')
        OR t.terminal_type IN ('turn.interrupted', 'turn.cancelled')) LIMIT 1`,
    sessionId, ownerScope, rootTurnId);
    if (stopped) return deny("TASK_CONTINUATION_CANCELLED");
    const targetClaim = db.get(
      "SELECT * FROM task_continuation_claims WHERE continuation_turn_id = ?", continuationTurnId,
    );
    const target = db.get("SELECT * FROM turn_inputs WHERE turn_id = ?", continuationTurnId);
    if (targetClaim && (targetClaim.session_id !== sessionId || targetClaim.owner_scope !== ownerScope
      || targetClaim.source_turn_id !== sourceTurnId || targetClaim.root_turn_id !== rootTurnId)) {
      return deny("TASK_CONTINUATION_IDENTITY_CONFLICT");
    }
    if (target && (!targetClaim || target.session_id !== sessionId || target.owner_scope !== ownerScope
      || target.migration_status !== "owned")) return deny("TASK_CONTINUATION_IDENTITY_CONFLICT");
    if (cancelled(target)) return deny("TASK_CONTINUATION_CANCELLED");
    const chain = db.get(
      `SELECT COUNT(*) AS rounds, MIN(root_started_at) AS started_at,
              json_group_array(progress_keys_json) AS progress_json
       FROM task_continuation_claims WHERE session_id = ? AND owner_scope = ? AND root_turn_id = ?`,
      sessionId, ownerScope, rootTurnId,
    );
    rounds = Number(chain.rounds);
    // Reconcile already admitted work, but do not dispatch an unadmitted claim
    // after its deadline merely because a crash left the reservation behind.
    if (targetClaim && !target && now - targetClaim.root_started_at >= MAX_ELAPSED_MS) return deny("TASK_CONTINUATION_DEADLINE");
    if (targetClaim) return { ok: true, rootTurnId, rounds, duplicate: true };
    if (rounds >= MAX_ROUNDS) return deny("TASK_CONTINUATION_BUDGET_EXHAUSTED");
    const startedAt = rounds ? chain.started_at : now;
    if (now - startedAt >= MAX_ELAPSED_MS) return deny("TASK_CONTINUATION_DEADLINE");
    if (!Array.isArray(progressKeys) || progressKeys.length > MAX_PROGRESS_KEYS
      || progressKeys.some((key) => typeof key !== "string" || !/^[a-fA-F0-9]{64}$/.test(key))) {
      return deny("TASK_CONTINUATION_INVALID_PROGRESS");
    }
    const keys = [...new Set(progressKeys.map((key) => key.toLowerCase()))];
    const seen = new Set(JSON.parse(chain.progress_json).flatMap((json) => JSON.parse(json)));
    if (rounds && !keys.some((key) => !seen.has(key))) return deny("TASK_CONTINUATION_NO_PROGRESS");
    rounds += 1;
    db.run(
      `INSERT INTO task_continuation_claims
       (continuation_turn_id, session_id, owner_scope, source_turn_id, root_turn_id,
        round, root_started_at, reserved_at, progress_keys_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      continuationTurnId, sessionId, ownerScope, sourceTurnId, rootTurnId,
      rounds, startedAt, now, JSON.stringify(keys),
    );
    return { ok: true, rootTurnId, rounds };
  })();
}

function validateTaskContinuation(db, input = {}) {
  const { sessionId, ownerScope, continuationTurnId } = input;
  if (![sessionId, ownerScope, continuationTurnId].every(validId)) {
    return { ok: false, reason: "TASK_CONTINUATION_INVALID_INPUT" };
  }
  ensureSchema(db);
  const claim = db.get("SELECT * FROM task_continuation_claims WHERE continuation_turn_id = ?", continuationTurnId);
  if (!claim) return { ok: true };
  if (claim.session_id !== sessionId || claim.owner_scope !== ownerScope) {
    return { ok: false, reason: "TASK_CONTINUATION_IDENTITY_CONFLICT" };
  }
  return reserveTaskContinuation(db, {
    sessionId, ownerScope, continuationTurnId, sourceTurnId: claim.source_turn_id,
    progressKeys: [], now: input.now,
  });
}

module.exports = { reserveTaskContinuation, cancelTaskContinuations, validateTaskContinuation, recordTaskContinuationSource };
