"use strict";

const crypto = require("node:crypto");
const {
  checkpointHash,
  createRuntimeCheckpointManifest,
  restorePlanForCheckpoint,
  verifyRuntimeCheckpointManifest,
} = require("../runtime-checkpoint");

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function migrateRuntimeCheckpointSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_checkpoints (
      id TEXT PRIMARY KEY,
      parent_checkpoint_id TEXT,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL DEFAULT '',
      engine_session_id TEXT NOT NULL DEFAULT '',
      engine_message_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      event_seq INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      integrity_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      committed_at INTEGER,
      FOREIGN KEY (parent_checkpoint_id) REFERENCES runtime_checkpoints(id)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_checkpoint_session
      ON runtime_checkpoints(session_id, status, created_at);

    CREATE TABLE IF NOT EXISTS runtime_checkpoint_components (
      checkpoint_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      reversible INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, type, ref_id),
      FOREIGN KEY (checkpoint_id) REFERENCES runtime_checkpoints(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runtime_checkpoint_component_data (
      checkpoint_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (checkpoint_id, type, ref_id),
      FOREIGN KEY (checkpoint_id, type, ref_id)
        REFERENCES runtime_checkpoint_components(checkpoint_id, type, ref_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runtime_checkpoint_restores (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      safety_checkpoint_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      unresolved_effects_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (checkpoint_id) REFERENCES runtime_checkpoints(id),
      FOREIGN KEY (safety_checkpoint_id) REFERENCES runtime_checkpoints(id)
    );
  `);
}

class RuntimeCheckpointStore {
  constructor(db, { now = () => Date.now() } = {}) {
    if (!db) throw codedError("RUNTIME_CHECKPOINT_DB_REQUIRED");
    this.db = db;
    this.now = now;
  }

  prepare(input = {}) {
    const manifest = createRuntimeCheckpointManifest(input);
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO runtime_checkpoints
          (id, parent_checkpoint_id, session_id, turn_id, task_run_id,
           engine_session_id, engine_message_id, kind, event_seq, status,
           integrity_hash, manifest_json, created_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, NULL)`,
        manifest.id, manifest.parentCheckpointId || null, manifest.sessionId,
        manifest.turnId, manifest.taskRunId, manifest.engineSessionId,
        manifest.engineMessageId, manifest.kind, manifest.eventSeq,
        manifest.integrityHash, JSON.stringify(manifest), manifest.createdAt,
      );
      for (const component of manifest.components) {
        this.db.run(
          `INSERT INTO runtime_checkpoint_components
            (checkpoint_id, type, ref_id, version, hash, reversible)
           VALUES (?, ?, ?, ?, ?, ?)`,
          manifest.id, component.type, component.refId, component.version,
          component.hash, component.reversible ? 1 : 0,
        );
        const source = (input.components || []).find((candidate) => (
          String(candidate.type) === component.type && String(candidate.refId) === component.refId
        ));
        if (source && Object.hasOwn(source, "payload")) {
          if (checkpointHash(source.payload) !== component.hash) throw codedError("RUNTIME_CHECKPOINT_COMPONENT_HASH_MISMATCH");
          this.db.run(
            `INSERT INTO runtime_checkpoint_component_data
              (checkpoint_id, type, ref_id, payload_json) VALUES (?, ?, ?, ?)`,
            manifest.id, component.type, component.refId, JSON.stringify(source.payload),
          );
        }
      }
      return manifest;
    })();
  }

  get(id, sessionId) {
    const row = this.db.get("SELECT * FROM runtime_checkpoints WHERE id=?", id);
    if (!row) throw codedError("RUNTIME_CHECKPOINT_NOT_FOUND", id);
    if (row.session_id !== sessionId) throw codedError("RUNTIME_CHECKPOINT_SCOPE_MISMATCH");
    const manifest = JSON.parse(row.manifest_json);
    const verified = verifyRuntimeCheckpointManifest(manifest);
    if (!verified.ok || verified.manifest.integrityHash !== row.integrity_hash) {
      throw codedError("RUNTIME_CHECKPOINT_INTEGRITY_MISMATCH");
    }
    return {
      ...verified.manifest,
      status: row.status,
      committedAt: row.committed_at == null ? null : Number(row.committed_at),
    };
  }

  componentData(id, sessionId) {
    const checkpoint = this.get(id, sessionId);
    const rows = this.db.all(
      `SELECT type, ref_id, payload_json FROM runtime_checkpoint_component_data
       WHERE checkpoint_id=? ORDER BY type, ref_id`, id,
    );
    const payloads = new Map(rows.map((row) => [`${row.type}\0${row.ref_id}`, JSON.parse(row.payload_json)]));
    return checkpoint.components.map((component) => {
      const payload = payloads.get(`${component.type}\0${component.refId}`);
      if (payload === undefined) return { ...component, payload: null, payloadAvailable: false };
      if (checkpointHash(payload) !== component.hash) throw codedError("RUNTIME_CHECKPOINT_COMPONENT_HASH_MISMATCH");
      return { ...component, payload, payloadAvailable: true };
    });
  }

  list(sessionId, { limit = 50 } = {}) {
    return this.db.all(
      `SELECT id FROM runtime_checkpoints WHERE session_id=? AND status='committed'
       ORDER BY created_at DESC, id DESC LIMIT ?`, sessionId, Math.max(1, Math.min(200, Number(limit) || 50)),
    ).map((row) => this.get(row.id, sessionId));
  }

  commit(id, sessionId, integrityHash) {
    return this.db.transaction(() => {
      const checkpoint = this.get(id, sessionId);
      if (checkpoint.integrityHash !== integrityHash) throw codedError("RUNTIME_CHECKPOINT_INTEGRITY_MISMATCH");
      if (checkpoint.status === "committed") return checkpoint;
      if (checkpoint.status !== "preparing") throw codedError("RUNTIME_CHECKPOINT_STATE_INVALID");
      const committedAt = this.now();
      const result = this.db.run(
        `UPDATE runtime_checkpoints SET status='committed', committed_at=?
         WHERE id=? AND session_id=? AND status='preparing' AND integrity_hash=?`,
        committedAt, id, sessionId, integrityHash,
      );
      if (Number(result.changes || 0) !== 1) throw codedError("RUNTIME_CHECKPOINT_STATE_CONFLICT");
      return this.get(id, sessionId);
    })();
  }

  beginRestore(id, sessionId, input = {}) {
    return this.db.transaction(() => {
      const checkpoint = this.get(id, sessionId);
      if (checkpoint.status !== "committed") throw codedError("RUNTIME_CHECKPOINT_NOT_COMMITTED");
      const restoreId = String(input.id || `restore_${crypto.randomUUID()}`);
      const createdAt = Number(input.createdAt ?? this.now());
      let safety;
      if (input.safetyCheckpointId) {
        safety = this.get(input.safetyCheckpointId, sessionId);
        if (safety.status !== "committed" || safety.kind !== "pre_restore_safety") {
          throw codedError("RUNTIME_CHECKPOINT_SAFETY_INVALID");
        }
      } else {
        const prepared = this.prepare({
          id: `safety_${restoreId}`,
          parentCheckpointId: checkpoint.id,
          sessionId,
          turnId: checkpoint.turnId,
          taskRunId: checkpoint.taskRunId,
          engineSessionId: checkpoint.engineSessionId,
          engineMessageId: checkpoint.engineMessageId,
          kind: "pre_restore_safety",
          eventSeq: checkpoint.eventSeq,
          components: checkpoint.components,
          effects: checkpoint.effects,
          createdAt,
        });
        safety = this.commit(prepared.id, sessionId, prepared.integrityHash);
      }
      const plan = restorePlanForCheckpoint(checkpoint);
      this.db.run(
        `INSERT INTO runtime_checkpoint_restores
          (id, checkpoint_id, safety_checkpoint_id, session_id, status,
           unresolved_effects_json, created_at, completed_at, error)
         VALUES (?, ?, ?, ?, 'restoring', ?, ?, NULL, '')`,
        restoreId, checkpoint.id, safety.id, sessionId,
        JSON.stringify(plan.unresolvedEffects), createdAt,
      );
      return {
        restore: { id: restoreId, checkpointId: id, safetyCheckpointId: safety.id, sessionId, status: "restoring", createdAt },
        safetyCheckpoint: this.get(safety.id, sessionId),
        plan,
      };
    })();
  }

  completeRestore(id, sessionId, input = {}) {
    const completedAt = Number(input.completedAt ?? this.now());
    const result = this.db.run(
      `UPDATE runtime_checkpoint_restores
       SET status='restored', completed_at=?, unresolved_effects_json=?
       WHERE id=? AND session_id=? AND status='restoring'`,
      completedAt, JSON.stringify(input.unresolvedEffects || []), id, sessionId,
    );
    if (Number(result.changes || 0) !== 1) throw codedError("RUNTIME_CHECKPOINT_RESTORE_STATE_INVALID");
    return { id, sessionId, status: "restored", completedAt, unresolvedEffects: input.unresolvedEffects || [] };
  }

  failRestore(id, sessionId, error, completedAt = this.now()) {
    const result = this.db.run(
      `UPDATE runtime_checkpoint_restores SET status='failed', completed_at=?, error=?
       WHERE id=? AND session_id=? AND status='restoring'`,
      completedAt, String(error || "restore failed").slice(0, 2_000), id, sessionId,
    );
    return Number(result.changes || 0) === 1;
  }

  fork(id, sessionId, input = {}) {
    const source = this.get(id, sessionId);
    if (source.status !== "committed") throw codedError("RUNTIME_CHECKPOINT_NOT_COMMITTED");
    const forked = this.prepare({
      id: input.id,
      parentCheckpointId: source.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      taskRunId: input.taskRunId || source.taskRunId,
      engineSessionId: input.engineSessionId || source.engineSessionId,
      engineMessageId: input.engineMessageId || source.engineMessageId,
      kind: "fork",
      eventSeq: source.eventSeq,
      components: this.componentData(id, sessionId).map(({ payload, payloadAvailable, ...component }) => ({
        ...component,
        ...(payloadAvailable ? { payload } : {}),
      })),
      effects: source.effects,
      createdAt: input.createdAt ?? this.now(),
    });
    return this.commit(forked.id, input.sessionId, forked.integrityHash);
  }
}

module.exports = { RuntimeCheckpointStore, migrateRuntimeCheckpointSchema };
