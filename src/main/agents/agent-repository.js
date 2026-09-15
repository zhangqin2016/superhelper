"use strict";

/**
 * Agent library repository over the shared messages.db (node:sqlite).
 *
 * Discipline mirrors character-worlds/repository.js: owner-scoped entities,
 * immutable revisions (append-only, CAS on the base revision), a per-session
 * binding with a monotonically increasing version, and an append-only event
 * log so "who activated what, when" is always answerable.
 *
 * Every write goes through normalizeAgentDefinition first — the repository
 * never stores a definition the validator has not seen.
 */

const crypto = require("node:crypto");
const C = require("./constants");
const {
  codedError,
  stableJson,
  normalizeAgentDefinition,
  agentDefinitionHash,
} = require("./agent-definition");

function requiredString(value, name) {
  const text = String(value || "");
  if (!text) throw codedError("AGENT_INPUT_INVALID", `${name} is required`, { field: name });
  return text;
}

function isoTime(value) {
  return value == null ? null : new Date(Number(value)).toISOString();
}

function normalizeSource(source) {
  const raw = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const kind = String(raw.kind || "").trim();
  if (!kind || kind.length > 64 || !/^[a-z][a-z0-9_-]*$/.test(kind)) {
    throw codedError("AGENT_SOURCE_INVALID", "Agent source.kind is required", { field: "source.kind" });
  }
  const out = { kind };
  for (const key of ["officialId", "officialVersion", "officialLocale", "publisher", "packageId", "packageVersion", "channel", "importedFrom"]) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = typeof raw[key] === "number" ? raw[key] : String(raw[key]).slice(0, 256);
    out[key] = value;
  }
  return out;
}

function parseJson(text, fallback = null) {
  try {
    const value = JSON.parse(String(text || ""));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function entityFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: C.AGENT_SCHEMA_VERSION,
    id: row.id,
    ownerScope: row.owner_scope,
    displayName: row.display_name,
    currentRevisionId: row.current_revision_id,
    officialId: row.official_id || null,
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    archivedAt: isoTime(row.archived_at),
  };
}

function revisionFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: C.AGENT_SCHEMA_VERSION,
    id: row.id,
    agentId: row.entity_id,
    ownerScope: row.owner_scope,
    parentRevisionId: row.parent_revision_id || null,
    revisionNumber: row.revision_number,
    displayName: row.display_name,
    definitionHash: row.definition_hash,
    definition: parseJson(row.definition_json, {}),
    source: parseJson(row.source_json, { kind: "unknown" }),
    createdAt: isoTime(row.created_at),
  };
}

function emptyBinding(sessionId, bindingVersion = 0) {
  return {
    schemaVersion: C.AGENT_BINDING_SCHEMA_VERSION,
    sessionId,
    bindingVersion,
    agentId: null,
    agentRevisionId: null,
    displayName: "",
    receipt: null,
    previous: null,
    updatedAt: null,
  };
}

function bindingFromRow(row, sessionId) {
  if (!row) return emptyBinding(sessionId);
  const stored = parseJson(row.binding_json, {});
  return {
    schemaVersion: C.AGENT_BINDING_SCHEMA_VERSION,
    sessionId,
    bindingVersion: Number(row.binding_version) || 0,
    agentId: row.agent_entity_id || null,
    agentRevisionId: row.agent_revision_id || null,
    displayName: String(stored.displayName || ""),
    receipt: stored.receipt && typeof stored.receipt === "object" ? stored.receipt : null,
    previous: stored.previous && typeof stored.previous === "object" ? stored.previous : null,
    updatedAt: isoTime(row.updated_at),
  };
}

class AgentRepository {
  constructor(messageStore) {
    if (!messageStore?.db) throw new TypeError("AgentRepository requires a MessageStore");
    this.store = messageStore;
    this.db = messageStore.db;
  }

  // -- entities / revisions -------------------------------------------------

  listAgents(ownerScope, { includeArchived = false } = {}) {
    const owner = requiredString(ownerScope, "ownerScope");
    const rows = this.db.all(
      `SELECT * FROM agent_entities WHERE owner_scope = ?${includeArchived ? "" : " AND archived_at IS NULL"}
       ORDER BY updated_at DESC, id ASC`,
      owner,
    );
    return rows.map(entityFromRow);
  }

  getAgent(ownerScope, agentId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(agentId, "agentId");
    return entityFromRow(this.db.get("SELECT * FROM agent_entities WHERE id = ? AND owner_scope = ?", id, owner));
  }

  findByOfficialId(ownerScope, officialId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(officialId, "officialId");
    return entityFromRow(this.db.get(
      "SELECT * FROM agent_entities WHERE owner_scope = ? AND official_id = ?",
      owner, id,
    ));
  }

  getRevision(ownerScope, revisionId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(revisionId, "revisionId");
    return revisionFromRow(this.db.get("SELECT * FROM agent_revisions WHERE id = ? AND owner_scope = ?", id, owner));
  }

  getCurrentRevision(ownerScope, agentId) {
    const entity = this.getAgent(ownerScope, agentId);
    return entity?.currentRevisionId ? this.getRevision(ownerScope, entity.currentRevisionId) : null;
  }

  listRevisions(ownerScope, agentId, { limit = 50 } = {}) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(agentId, "agentId");
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.db.all(
      `SELECT * FROM agent_revisions WHERE owner_scope = ? AND entity_id = ?
       ORDER BY revision_number DESC LIMIT ?`,
      owner, id, bounded,
    ).map(revisionFromRow);
  }

  _insertRevision({ owner, entityId, parentId, number, definition, source, createdAt }) {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO agent_revisions
         (id, entity_id, owner_scope, parent_revision_id, revision_number, display_name,
          definition_json, definition_hash, source_kind, source_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, entityId, owner, parentId, number, definition.name,
      stableJson(definition), agentDefinitionHash(definition), source.kind, stableJson(source), createdAt,
    );
    this.db.run(
      `UPDATE agent_entities SET current_revision_id = ?, display_name = ?, updated_at = ?
       WHERE id = ? AND owner_scope = ?`,
      id, definition.name, createdAt, entityId, owner,
    );
    return id;
  }

  /** Create a new agent entity with its first revision. */
  createAgent({ ownerScope, definition, source, officialId = null }) {
    const owner = requiredString(ownerScope, "ownerScope");
    const normalized = normalizeAgentDefinition(definition);
    const src = normalizeSource(source);
    return this.db.transaction(() => {
      const createdAt = Date.now();
      const entityId = crypto.randomUUID();
      if (officialId) {
        const existing = this.findByOfficialId(owner, officialId);
        if (existing) throw codedError("AGENT_OFFICIAL_EXISTS", "Official agent already installed", { agentId: existing.id });
      }
      this.db.run(
        `INSERT INTO agent_entities (id, owner_scope, display_name, current_revision_id, official_id, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
        entityId, owner, normalized.name, officialId || null, createdAt, createdAt,
      );
      const revisionId = this._insertRevision({
        owner, entityId, parentId: null, number: 1, definition: normalized, source: src, createdAt,
      });
      return { entity: this.getAgent(owner, entityId), revision: this.getRevision(owner, revisionId) };
    })();
  }

  /** Append a revision. CAS: expectedBaseRevisionId must be the current tip. */
  createRevision({ ownerScope, agentId, expectedBaseRevisionId, definition, source }) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(agentId, "agentId");
    const normalized = normalizeAgentDefinition(definition);
    const src = normalizeSource(source);
    return this.db.transaction(() => {
      const entity = this.getAgent(owner, id);
      if (!entity) throw codedError("AGENT_NOT_FOUND", "Agent not found");
      if (entity.archivedAt) throw codedError("AGENT_ARCHIVED", "Agent is archived");
      if (expectedBaseRevisionId !== undefined && entity.currentRevisionId !== (expectedBaseRevisionId || null)) {
        throw codedError("AGENT_REVISION_CONFLICT", "Agent revision is stale", { currentRevisionId: entity.currentRevisionId });
      }
      const current = entity.currentRevisionId ? this.getRevision(owner, entity.currentRevisionId) : null;
      if (current && current.definitionHash === agentDefinitionHash(normalized) && current.source.kind === src.kind) {
        // Idempotent: same content, same provenance → no new row.
        return { entity, revision: current, unchanged: true };
      }
      const revisionId = this._insertRevision({
        owner, entityId: id, parentId: entity.currentRevisionId, number: (current?.revisionNumber || 0) + 1,
        definition: normalized, source: src, createdAt: Date.now(),
      });
      return { entity: this.getAgent(owner, id), revision: this.getRevision(owner, revisionId), unchanged: false };
    })();
  }

  archiveAgent(ownerScope, agentId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(agentId, "agentId");
    const now = Date.now();
    this.db.run(
      `UPDATE agent_entities SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ? AND owner_scope = ?`,
      now, now, id, owner,
    );
    return this.getAgent(owner, id);
  }

  restoreAgent(ownerScope, agentId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(agentId, "agentId");
    this.db.run(
      `UPDATE agent_entities SET archived_at = NULL, updated_at = ? WHERE id = ? AND owner_scope = ?`,
      Date.now(), id, owner,
    );
    return this.getAgent(owner, id);
  }

  // -- session bindings -----------------------------------------------------

  getBinding(sessionId, ownerScope) {
    const sid = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    const row = this.db.get("SELECT * FROM agent_session_bindings WHERE session_id = ?", sid);
    if (row && row.owner_scope !== owner) {
      throw codedError("AGENT_BINDING_OWNER_MISMATCH", "Session agent binding belongs to another owner scope");
    }
    return bindingFromRow(row, sid);
  }

  /** Sessions currently bound to an agent entity (for library "in use" hints). */
  countBindingsForAgent(ownerScope, agentId) {
    const owner = requiredString(ownerScope, "ownerScope");
    const id = requiredString(agentId, "agentId");
    const row = this.db.get(
      "SELECT COUNT(*) AS n FROM agent_session_bindings WHERE owner_scope = ? AND agent_entity_id = ?",
      owner, id,
    );
    return Number(row?.n) || 0;
  }

  /**
   * Set (or clear, with agentRevisionId=null) a session's agent binding.
   * CAS on expectedBindingVersion; records the activation receipt and the
   * pre-activation snapshot so deactivation can restore exactly.
   */
  setBinding({ sessionId, ownerScope, expectedBindingVersion, agentRevisionId = null, receipt = null, previous = null }) {
    const sid = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    if (!Number.isInteger(expectedBindingVersion) || expectedBindingVersion < 0) {
      throw codedError("AGENT_INPUT_INVALID", "expectedBindingVersion must be a non-negative integer", { field: "expectedBindingVersion" });
    }
    return this.db.transaction(() => {
      const current = this.getBinding(sid, owner);
      if (current.bindingVersion !== expectedBindingVersion) {
        throw codedError("AGENT_BINDING_CONFLICT", "Agent binding version is stale", { current });
      }
      let revision = null;
      if (agentRevisionId) {
        revision = this.getRevision(owner, agentRevisionId);
        if (!revision) throw codedError("AGENT_REVISION_NOT_FOUND", "Agent revision not found");
      }
      const now = Date.now();
      const next = {
        schemaVersion: C.AGENT_BINDING_SCHEMA_VERSION,
        bindingVersion: current.bindingVersion + 1,
        agentId: revision?.agentId || null,
        agentRevisionId: revision?.id || null,
        displayName: revision?.displayName || "",
        receipt: receipt && typeof receipt === "object" ? receipt : null,
        previous: previous && typeof previous === "object" ? previous : null,
      };
      const json = stableJson(next);
      if (Buffer.byteLength(json, "utf8") > C.MAX_AGENT_BINDING_BYTES) {
        throw codedError("AGENT_BINDING_TOO_LARGE", `Agent binding exceeds ${C.MAX_AGENT_BINDING_BYTES} bytes`);
      }
      this.db.run(
        `INSERT INTO agent_session_bindings
           (session_id, owner_scope, binding_version, agent_entity_id, agent_revision_id, binding_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           binding_version = excluded.binding_version,
           agent_entity_id = excluded.agent_entity_id,
           agent_revision_id = excluded.agent_revision_id,
           binding_json = excluded.binding_json,
           updated_at = excluded.updated_at`,
        sid, owner, next.bindingVersion, next.agentId, next.agentRevisionId, json, now,
      );
      this.db.run(
        `INSERT INTO agent_binding_events (id, session_id, owner_scope, binding_version, event_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), sid, owner, next.bindingVersion,
        stableJson({
          type: next.agentRevisionId ? "agent_binding.activated" : "agent_binding.cleared",
          previousAgentRevisionId: current.agentRevisionId,
          nextAgentRevisionId: next.agentRevisionId,
          receipt: next.receipt,
          createdAt: isoTime(now),
        }),
        now,
      );
      return this.getBinding(sid, owner);
    })();
  }

  getBindingEvents(sessionId, ownerScope, { afterVersion = 0, limit = 100 } = {}) {
    const sid = requiredString(sessionId, "sessionId");
    const owner = requiredString(ownerScope, "ownerScope");
    return this.db.all(
      `SELECT * FROM agent_binding_events WHERE session_id = ? AND owner_scope = ? AND binding_version > ?
       ORDER BY binding_version ASC LIMIT ?`,
      sid, owner, Math.max(0, Number(afterVersion) || 0), Math.max(1, Math.min(200, Number(limit) || 100)),
    ).map((row) => ({
      id: row.id,
      bindingVersion: row.binding_version,
      createdAt: isoTime(row.created_at),
      ...parseJson(row.event_json, {}),
    }));
  }
}

module.exports = { AgentRepository, entityFromRow, revisionFromRow, emptyBinding };
