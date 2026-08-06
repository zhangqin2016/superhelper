"use strict";

const crypto = require("node:crypto");

const MAX_SNAPSHOT_BYTES = 128 * 1024;

function safeJson(value) {
  try {
    const json = JSON.stringify(value && typeof value === "object" ? value : {});
    return Buffer.byteLength(json, "utf8") <= MAX_SNAPSHOT_BYTES ? json : null;
  } catch {
    return null;
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

function registryId({ sessionId, ownerScope, taskId, turnId, sourceFingerprint } = {}) {
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    sessionId, ownerScope, taskId, turnId, sourceFingerprint,
  })).digest("hex").slice(0, 40);
  return `ctx_${digest}`;
}

function replayabilityFor(snapshot = {}) {
  const files = Array.isArray(snapshot?.sources?.files) ? snapshot.sources.files : [];
  const reasons = new Set();
  for (const file of files) {
    if (file?.contentRef) continue;
    if (file?.path) reasons.add("PATH_BACKED_SOURCE");
    else reasons.add("UNRESOLVED_SOURCE");
  }
  return {
    mode: reasons.size ? "revalidate" : "exact",
    reasons: [...reasons],
  };
}

function hydrate(row) {
  if (!row) return null;
  const snapshot = parseJson(row.snapshot_json);
  return Object.freeze({
    registryId: row.registry_id,
    sessionId: row.session_id,
    ownerScope: row.owner_scope,
    taskId: row.task_id,
    turnId: row.turn_id,
    sourceFingerprint: row.source_fingerprint,
    replayability: parseJson(row.replayability_json),
    snapshot,
    createdAt: Number(row.created_at || 0),
  });
}

function migrateTaskContextRegistrySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_context_registry (
      registry_id       TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      owner_scope       TEXT NOT NULL,
      task_id           TEXT NOT NULL,
      turn_id           TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      replayability_json TEXT NOT NULL DEFAULT '{}',
      snapshot_json     TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      UNIQUE (session_id, owner_scope, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_context_registry_owner
      ON task_context_registry(owner_scope, task_id, created_at);
  `);
}

function createTaskContextRegistryStoreMethods() {
  return {
    persistTaskContextSnapshot({
      registryId: requestedRegistryId = "",
      sessionId,
      ownerScope,
      taskId,
      turnId,
      snapshot,
      now = Date.now(),
    } = {}) {
      const json = safeJson(snapshot);
      const sourceFingerprint = String(snapshot?.sourceFingerprint || "");
      const id = requestedRegistryId || registryId({ sessionId, ownerScope, taskId, turnId, sourceFingerprint });
      if (!sessionId || !ownerScope || !taskId || !turnId || !json || !sourceFingerprint) {
        return Object.freeze({ ok: false, reason: "INVALID_TASK_CONTEXT_SNAPSHOT", context: null });
      }
      const replayability = replayabilityFor(snapshot);
      return this.db.transaction(() => {
        const existing = this.db.get(
          `SELECT * FROM task_context_registry WHERE session_id=? AND owner_scope=? AND turn_id=?`,
          sessionId, ownerScope, turnId,
        );
        if (existing) {
          const same = existing.registry_id === id
            && existing.source_fingerprint === sourceFingerprint
            && existing.snapshot_json === json;
          return Object.freeze({
            ok: same,
            idempotent: same,
            reason: same ? null : "TASK_CONTEXT_IMMUTABLE",
            context: hydrate(existing),
          });
        }
        const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        this.db.run(
          `INSERT INTO task_context_registry
             (registry_id, session_id, owner_scope, task_id, turn_id,
              source_fingerprint, replayability_json, snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          sessionId,
          ownerScope,
          taskId,
          turnId,
          sourceFingerprint,
          JSON.stringify(replayability),
          json,
          timestamp,
        );
        return Object.freeze({ ok: true, idempotent: false, reason: null, context: hydrate(this.db.get(
          `SELECT * FROM task_context_registry WHERE registry_id=?`, id,
        )) });
      })();
    },

    getTaskContextSnapshot(sessionId, ownerScope, turnId) {
      if (!sessionId || !ownerScope || !turnId) return null;
      return hydrate(this.db.get(
        `SELECT * FROM task_context_registry WHERE session_id=? AND owner_scope=? AND turn_id=?`,
        sessionId, ownerScope, turnId,
      ));
    },
  };
}

module.exports = {
  createTaskContextRegistryStoreMethods,
  migrateTaskContextRegistrySchema,
  registryId,
  replayabilityFor,
};
