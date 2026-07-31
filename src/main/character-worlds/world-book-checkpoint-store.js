"use strict";

/**
 * Durable world-book timed-effect checkpoints (§10.4.6, Phase 2 Task WB-4).
 *
 * The activation resolver computes the NEXT checkpoint purely; this store is
 * the durable half. A row is keyed by (ownerScope, sessionId,
 * worldBookRevisionId) and is written ONLY after successful turn
 * finalization (see turn-terminal-finalizer.js) — failed, interrupted,
 * stalled, and outcome-unknown turns never advance it.
 *
 * Replay semantics (documented choice): a retried turn RECOMPUTES its
 * activation deterministically from this pre-turn checkpoint (the resolver is
 * pure), so the stored activationFingerprint/turnId are audit metadata, never
 * required inputs. A failed attempt leaves the row untouched, so the retry
 * replays the identical activation.
 *
 * Crash window (documented): the checkpoint write is a SEPARATE, LATER
 * transaction than the terminal CAS that finalizes the turn (the finalizer
 * writes it after the terminal event, just before turn-state cleanup). A
 * crash in between leaves a durable completed turn with NO checkpoint row —
 * bounded and self-healing: the next turn simply recomputes from the
 * previous (pre-turn) checkpoint and its own successful finalization writes
 * the row. Timed effects may fire one turn late, never wrong.
 *
 * Rewind invalidation (§10.4.6): deleting canonical messages (rewind)
 * invalidates every row for that session — sticky/cooldown/delay sequence
 * numbers point at deleted history. session-manager.deleteMessagesFromTurn
 * purges them via deleteWorldBookCheckpointsForSession immediately after the
 * message transaction commits (documented there).
 *
 * Writes are transactional upserts guarded by an optimistic version:
 * `expectedVersion` must match the persisted version (0 = no row) or the
 * write conflicts with WORLD_BOOK_CHECKPOINT_CONFLICT and the caller fails
 * open (the next turn simply re-reads). Rows and keys are byte-bounded; every
 * read is owner-scoped. A corrupt row can never wedge future writes: the
 * read deletes it transactionally (audit-logged) and reports absence, so the
 * next guarded write (expectedVersion 0) succeeds.
 */

const {
  codedError,
  requiredString,
  stableJson,
} = require("./persistence-codec");

const MAX_CHECKPOINT_KEY_BYTES = 512;
const MAX_CHECKPOINT_JSON_BYTES = 256 * 1024;
const MAX_ACTIVATION_FINGERPRINT_BYTES = 128;

/**
 * Schema v10 — additive world_book_checkpoints table. Unlike the revision
 * tables these rows are deliberately mutable: each successful turn
 * transactionally replaces the row for its (owner, session, book) key.
 */
function migrateWorldBookCheckpointSchema(db) {
  db.exec(`
    CREATE TABLE world_book_checkpoints (
      owner_scope TEXT NOT NULL,
      session_id TEXT NOT NULL,
      world_book_revision_id TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      activation_fingerprint TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL CHECK (version >= 1),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_scope, session_id, world_book_revision_id)
    );
    CREATE INDEX idx_world_book_checkpoints_owner_session
      ON world_book_checkpoints(owner_scope, session_id);
  `);
}

function boundedKey(value, name) {
  const text = requiredString(value, name);
  if (Buffer.byteLength(text, "utf8") > MAX_CHECKPOINT_KEY_BYTES) {
    throw codedError("WORLD_BOOK_CHECKPOINT_INPUT", `${name} exceeds the key bound`, {
      limit: MAX_CHECKPOINT_KEY_BYTES,
    });
  }
  return text;
}

function packCheckpoint(checkpoint) {
  let json;
  try {
    json = stableJson(checkpoint ?? {});
  } catch {
    throw codedError("WORLD_BOOK_CHECKPOINT_INPUT", "checkpoint must be plain JSON data");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_CHECKPOINT_JSON_BYTES) {
    throw codedError("WORLD_BOOK_CHECKPOINT_TOO_LARGE", "checkpoint exceeds the byte bound", {
      limit: MAX_CHECKPOINT_JSON_BYTES,
    });
  }
  return json;
}

function readWorldBookCheckpoint(repository, {
  ownerScope,
  sessionId,
  worldBookRevisionId,
} = {}) {
  const owner = boundedKey(ownerScope, "ownerScope");
  const session = boundedKey(sessionId, "sessionId");
  const book = boundedKey(worldBookRevisionId, "worldBookRevisionId");
  const row = repository.db.get(
    `SELECT checkpoint_json, turn_id, activation_fingerprint, version
     FROM world_book_checkpoints
     WHERE owner_scope = ? AND session_id = ? AND world_book_revision_id = ?`,
    owner, session, book,
  );
  if (!row) return null;
  let checkpoint = null;
  try {
    checkpoint = JSON.parse(row.checkpoint_json);
  } catch {
    // A corrupt row must never wedge future writes: delete it inside one
    // transaction (audit-logged with the row key, never its payload) and
    // report absence, so the next guarded write (expectedVersion 0) lands.
    try {
      repository.db.transaction(() => {
        repository.db.run(
          `DELETE FROM world_book_checkpoints
           WHERE owner_scope = ? AND session_id = ? AND world_book_revision_id = ?`,
          owner, session, book,
        );
      })();
      require("../logger").getLogger("world-book-checkpoint").warn(
        "deleted corrupt world-book checkpoint row: session=%s revision=%s",
        session,
        book,
      );
    } catch {
      // The delete is best-effort; the read still fails open to absent.
    }
    return null;
  }
  return {
    checkpoint,
    turnId: row.turn_id,
    activationFingerprint: row.activation_fingerprint || "",
    version: row.version,
  };
}

/**
 * Rewind invalidation (§10.4.6): delete every checkpoint row for a session
 * whose canonical messages were deleted. Owner-scoped; returns the number of
 * rows removed.
 */
function deleteWorldBookCheckpointsForSession(repository, ownerScope, sessionId) {
  const owner = boundedKey(ownerScope, "ownerScope");
  const session = boundedKey(sessionId, "sessionId");
  return repository.db.transaction(() => (
    repository.db.run(
      `DELETE FROM world_book_checkpoints
       WHERE owner_scope = ? AND session_id = ?`,
      owner, session,
    ).changes
  ))();
}

/**
 * Transactional upsert with an optimistic version guard. `expectedVersion`
 * (when given) must equal the persisted version — 0 asserts no row exists.
 * Returns {version} of the written row.
 */
function writeWorldBookCheckpoint(repository, {
  ownerScope,
  sessionId,
  worldBookRevisionId,
  checkpoint,
  turnId,
  activationFingerprint = "",
  expectedVersion = null,
} = {}) {
  const owner = boundedKey(ownerScope, "ownerScope");
  const session = boundedKey(sessionId, "sessionId");
  const book = boundedKey(worldBookRevisionId, "worldBookRevisionId");
  const turn = boundedKey(turnId, "turnId");
  const fingerprint = String(activationFingerprint || "");
  if (Buffer.byteLength(fingerprint, "utf8") > MAX_ACTIVATION_FINGERPRINT_BYTES) {
    throw codedError("WORLD_BOOK_CHECKPOINT_INPUT", "activationFingerprint exceeds the bound");
  }
  const json = packCheckpoint(checkpoint);
  return repository.db.transaction(() => {
    const current = repository.db.get(
      `SELECT version FROM world_book_checkpoints
       WHERE owner_scope = ? AND session_id = ? AND world_book_revision_id = ?`,
      owner, session, book,
    );
    const currentVersion = current ? current.version : 0;
    if (expectedVersion !== null && expectedVersion !== undefined
        && Number(expectedVersion) !== currentVersion) {
      throw codedError(
        "WORLD_BOOK_CHECKPOINT_CONFLICT",
        "world-book checkpoint was advanced by another turn",
        { expectedVersion: Number(expectedVersion), currentVersion },
      );
    }
    const version = currentVersion + 1;
    repository.db.run(
      `INSERT INTO world_book_checkpoints
         (owner_scope, session_id, world_book_revision_id, checkpoint_json,
          turn_id, activation_fingerprint, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_scope, session_id, world_book_revision_id)
       DO UPDATE SET checkpoint_json = excluded.checkpoint_json,
                     turn_id = excluded.turn_id,
                     activation_fingerprint = excluded.activation_fingerprint,
                     version = excluded.version,
                     updated_at = excluded.updated_at`,
      owner, session, book, json, turn, fingerprint, version, Date.now(),
    );
    return { version };
  })();
}

module.exports = {
  MAX_CHECKPOINT_JSON_BYTES,
  deleteWorldBookCheckpointsForSession,
  migrateWorldBookCheckpointSchema,
  readWorldBookCheckpoint,
  writeWorldBookCheckpoint,
};
