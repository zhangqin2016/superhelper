"use strict";

const crypto = require("node:crypto");

const MEMORY_KINDS = new Set(["scene_fact", "character_belief", "relationship", "open_thread"]);
const CONFIDENCE_KINDS = new Set(["explicit", "derived"]);
const MAX_MEMORY_TEXT_BYTES = 4096;
const MAX_ITEMS_PER_SCOPE = 64;
const MAX_MEMORY_BYTES = 4 * 1024;

function textKey(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function rowToMemory(row) {
  let sourceTurnIds = [];
  try {
    const parsed = JSON.parse(row.source_turn_ids);
    sourceTurnIds = Array.isArray(parsed) ? parsed : [];
  } catch {}
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    sessionId: row.session_id,
    characterRevisionId: row.character_revision_id,
    turnId: row.turn_id,
    kind: row.kind,
    text: row.text,
    sourceTurnIds,
    confidence: row.confidence,
    supersedesId: row.supersedes_id || null,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at || null,
  };
}

function sourceIds(value, fallback) {
  const ids = Array.isArray(value) ? value : [];
  const result = ids.filter((item) => typeof item === "string" && item).slice(0, 32);
  return result.length ? result : [fallback];
}

class CharacterSceneMemoryService {
  constructor({ store = null, db = null, ownerScope } = {}) {
    db = db || store?.db;
    if (!db) throw new TypeError("scene_memory_store_required");
    if (typeof ownerScope !== "string" || !ownerScope) throw new TypeError("scene_memory_owner_required");
    this.store = store;
    this.db = db;
    this.ownerScope = ownerScope;
  }

  appendTurnMemory({ sessionId, characterRevisionId, turnId, finalized, items = [] } = {}) {
    if (finalized !== true) return { items: [], deduped: 0 };
    if (![sessionId, characterRevisionId, turnId].every((value) => typeof value === "string" && value)) {
      throw new TypeError("scene_memory_identity_required");
    }
    const accepted = [];
    let deduped = 0;
    const now = Date.now();
    this.db.transaction(() => {
      for (const item of Array.isArray(items) ? items.slice(0, MAX_ITEMS_PER_SCOPE) : []) {
        const kind = item?.kind;
        const text = typeof item?.text === "string" ? item.text.normalize("NFC").trim() : "";
        const sourceTurnIds = sourceIds(item?.sourceTurnIds, turnId);
        const confidence = item?.confidence || "derived";
        if (!MEMORY_KINDS.has(kind) || !CONFIDENCE_KINDS.has(confidence)) continue;
        if (!text || Buffer.byteLength(text, "utf8") > MAX_MEMORY_TEXT_BYTES) continue;
        if (!sourceTurnIds.includes(turnId)) continue;
        const normalizedHash = hash(textKey(text));
        const sourceHash = hash(JSON.stringify([...sourceTurnIds].sort()));
        const existing = this.db.get(
          `SELECT id FROM character_scene_memory
           WHERE owner_scope = ? AND session_id = ? AND character_revision_id = ?
             AND normalized_hash = ? AND source_hash = ?`,
          this.ownerScope, sessionId, characterRevisionId, normalizedHash, sourceHash,
        );
        if (existing) {
          deduped += 1;
          continue;
        }
        const memory = {
          id: crypto.randomUUID(), ownerScope: this.ownerScope, sessionId,
          characterRevisionId, turnId, kind, text, sourceTurnIds, confidence,
          supersedesId: typeof item?.supersedesId === "string" ? item.supersedesId : null,
          createdAt: now,
        };
        this.db.run(
          `INSERT INTO character_scene_memory
             (id, owner_scope, session_id, character_revision_id, turn_id, kind, text,
              normalized_hash, source_turn_ids, source_hash, confidence, supersedes_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          memory.id, this.ownerScope, sessionId, characterRevisionId, turnId, kind, text,
          normalizedHash, JSON.stringify(sourceTurnIds), sourceHash, confidence,
          memory.supersedesId, now,
        );
        accepted.push(memory);
      }
      this._writeCheckpoint(sessionId, characterRevisionId, turnId, now);
    })();
    return { items: accepted, deduped };
  }

  _activeRows(sessionId, characterRevisionId) {
    const rows = this.db.all(
      `SELECT * FROM character_scene_memory
       WHERE owner_scope = ? AND session_id = ? AND character_revision_id = ?
         AND invalidated_at IS NULL ORDER BY created_at ASC, id ASC`,
      this.ownerScope, sessionId, characterRevisionId,
    ).map(rowToMemory);
    const superseded = new Set(rows.filter((row) => row.supersedesId).map((row) => row.supersedesId));
    return rows.filter((row) => !superseded.has(row.id)).slice(-MAX_ITEMS_PER_SCOPE);
  }

  listMemory({ sessionId, characterRevisionId, limit = MAX_ITEMS_PER_SCOPE, budget = MAX_MEMORY_BYTES } = {}) {
    let remaining = Number.isFinite(budget) && budget > 0 ? budget : MAX_MEMORY_BYTES;
    const result = [];
    const boundedLimit = Math.max(1, Math.min(Number(limit) || MAX_ITEMS_PER_SCOPE, MAX_ITEMS_PER_SCOPE));
    for (const item of this._activeRows(sessionId, characterRevisionId).slice(-boundedLimit)) {
      const bytes = Buffer.byteLength(`- [${item.kind}] ${item.text}`, "utf8") + 1;
      if (bytes > remaining) continue;
      result.push(item);
      remaining -= bytes;
    }
    return result;
  }

  _writeCheckpoint(sessionId, characterRevisionId, turnId, createdAt = Date.now()) {
    const memoryIds = this._activeRows(sessionId, characterRevisionId).map((item) => item.id);
    this.db.run(
      `INSERT INTO character_scene_memory_checkpoints
         (owner_scope, session_id, character_revision_id, turn_id, memory_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_scope, session_id, character_revision_id, turn_id)
       DO UPDATE SET memory_ids_json = excluded.memory_ids_json, created_at = excluded.created_at`,
      this.ownerScope, sessionId, characterRevisionId, turnId, JSON.stringify(memoryIds), createdAt,
    );
  }

  checkpointFor({ sessionId, characterRevisionId, turnId } = {}) {
    const row = this.db.get(
      `SELECT * FROM character_scene_memory_checkpoints
       WHERE owner_scope = ? AND session_id = ? AND character_revision_id = ? AND turn_id = ?`,
      this.ownerScope, sessionId, characterRevisionId, turnId,
    );
    if (row) return { ...row, memoryIds: JSON.parse(row.memory_ids_json || "[]") };
    this._writeCheckpoint(sessionId, characterRevisionId, turnId);
    const created = this.db.get(
      `SELECT * FROM character_scene_memory_checkpoints
       WHERE owner_scope = ? AND session_id = ? AND character_revision_id = ? AND turn_id = ?`,
      this.ownerScope, sessionId, characterRevisionId, turnId,
    );
    return created ? { ...created, memoryIds: JSON.parse(created.memory_ids_json || "[]") } : null;
  }

  rewindTo({ sessionId, characterRevisionId, retainedTurnId } = {}) {
    const checkpoint = this.checkpointFor({ sessionId, characterRevisionId, turnId: retainedTurnId });
    const keep = new Set(checkpoint?.memoryIds || []);
    const active = this._activeRows(sessionId, characterRevisionId);
    const invalidated = active.filter((item) => !keep.has(item.id));
    if (invalidated.length) {
      this.db.run(
        `UPDATE character_scene_memory SET invalidated_at = ?
         WHERE owner_scope = ? AND session_id = ? AND character_revision_id = ?
           AND invalidated_at IS NULL AND id IN (${invalidated.map(() => "?").join(",")})`,
        Date.now(), this.ownerScope, sessionId, characterRevisionId, ...invalidated.map((item) => item.id),
      );
    }
    return { invalidated: invalidated.length, checkpoint };
  }
}

function sceneMemorySection(items = []) {
  let remaining = MAX_MEMORY_BYTES;
  const parts = [];
  for (const item of Array.isArray(items) ? items : []) {
    const line = `- [${item.kind}] ${String(item.text || "").trim()}`;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim() || bytes > remaining) continue;
    parts.push(line);
    remaining -= bytes;
  }
  return { authority: "narrative", text: parts.join("\n") };
}

module.exports = {
  CharacterSceneMemoryService,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_TEXT_BYTES,
  sceneMemorySection,
};
