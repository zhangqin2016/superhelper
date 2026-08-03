"use strict";

const crypto = require("node:crypto");

function migratePublicHookSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_hook_executions (
      id TEXT PRIMARY KEY,
      hook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      turn_id TEXT NOT NULL DEFAULT '',
      audit_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_hook_session
      ON runtime_hook_executions(session_id, started_at DESC);
  `);
}

class PublicHookAuditStore {
  constructor(db) { this.db = db; }

  record(event = {}) {
    const id = String(event.executionId || `hook_exec_${crypto.randomUUID()}`);
    const status = String(event.type || "hook.audit").replace(/^hook\./, "");
    const sessionId = String(event.sessionId || event.payload?.sessionId || "");
    const turnId = String(event.turnId || event.payload?.turnId || "");
    const now = Number(event.ts || Date.now());
    this.db.run(
      `INSERT INTO runtime_hook_executions
        (id, hook_id, event_type, mode, status, session_id, turn_id, audit_json, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,
         audit_json=excluded.audit_json, completed_at=excluded.completed_at`,
      id, String(event.hookId || ""), String(event.eventType || ""), String(event.mode || "observe"), status,
      sessionId, turnId, JSON.stringify(event), now, status === "started" ? null : now,
    );
    return id;
  }

  list(sessionId, limit = 100) {
    return this.db.all(
      `SELECT audit_json FROM runtime_hook_executions WHERE session_id=?
       ORDER BY started_at DESC LIMIT ?`,
      String(sessionId || ""), Math.max(1, Math.min(500, Number(limit) || 100)),
    ).map((row) => JSON.parse(row.audit_json));
  }
}

module.exports = { PublicHookAuditStore, migratePublicHookSchema };
