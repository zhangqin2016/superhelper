"use strict";

const crypto = require("node:crypto");

class CharacterWorldsReceiptStore {
  constructor({ repository, now = Date.now } = {}) {
    if (!repository?.db) throw new TypeError("receipt store requires repository");
    this.db = repository.db;
    this.now = now;
  }

  create({ ownerScope, sessionId, turnId, toolCallId, kind, entityId, revisionId, safe }) {
    const id = crypto.randomUUID();
    const safeJson = JSON.stringify(safe);
    if (Buffer.byteLength(safeJson, "utf8") > 8192) throw new RangeError("receipt safe payload too large");
    this.db.run(
      `INSERT OR IGNORE INTO character_worlds_receipts
         (id, owner_scope, session_id, turn_id, tool_call_id, kind, entity_id,
          revision_id, safe_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ownerScope, sessionId, turnId, toolCallId, kind, entityId,
      revisionId, safeJson, Number(this.now()) || Date.now(),
    );
    return this.getByToolCall(ownerScope, sessionId, turnId, toolCallId);
  }

  getByToolCall(ownerScope, sessionId, turnId, toolCallId) {
    return this._row(this.db.get(
      `SELECT * FROM character_worlds_receipts
       WHERE owner_scope = ? AND session_id = ? AND turn_id = ? AND tool_call_id = ?`,
      ownerScope, sessionId, turnId, toolCallId,
    ));
  }

  get(ownerScope, sessionId, receiptId) {
    return this._row(this.db.get(
      `SELECT * FROM character_worlds_receipts
       WHERE id = ? AND owner_scope = ? AND session_id = ?`,
      receiptId, ownerScope, sessionId,
    ));
  }

  getLatestByRevision(ownerScope, sessionId, revisionId) {
    return this._row(this.db.get(
      `SELECT * FROM character_worlds_receipts
       WHERE owner_scope = ? AND session_id = ? AND revision_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      ownerScope, sessionId, revisionId,
    ));
  }

  _row(row) {
    if (!row) return null;
    try {
      return Object.freeze({
        id: row.id,
        ownerScope: row.owner_scope,
        sessionId: row.session_id,
        turnId: row.turn_id,
        toolCallId: row.tool_call_id,
        kind: row.kind,
        entityId: row.entity_id,
        revisionId: row.revision_id,
        safe: Object.freeze(JSON.parse(row.safe_json)),
        createdAt: row.created_at,
      });
    } catch {
      return null;
    }
  }
}

module.exports = { CharacterWorldsReceiptStore };
