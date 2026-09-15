"use strict";

/**
 * 智能体 workspace portability — the `.lilyspace/agents.json` pack section.
 *
 * Export: the agents bound to a project's sessions (definitions only). Local
 * role cards travel INSIDE the entry as `roleCard` (canonical) when the caller
 * opts in, so the importer can recreate them through the same hostile
 * pipeline; official roles stay references. Nothing else leaves the machine:
 * no owner scope, session ids, receipts, or local entity ids.
 *
 * Import: every agent is validated through normalizeAgentDefinition, gets NEW
 * local ids, dedupes against an identical existing definition, and records
 * `imported` provenance. Bindings are not restored (sessions are not part of
 * a workspace pack); the agents land in the library ready to activate.
 */

const crypto = require("node:crypto");
const { normalizeAgentDefinition, agentDefinitionHash, stableJson } = require("./agent-definition");
const { AGENT_SOURCE_KINDS } = require("./constants");

const PACK_AGENTS_ENTRY = ".lilyspace/agents.json";
const PACK_SCHEMA_VERSION = 1;
const MAX_PACK_AGENTS = 32;
const MAX_PACK_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ROLE_CARD_BYTES = 1024 * 1024;

function writePackEntry(zip, json) {
  if (String(json || "").trim()) zip.file(PACK_AGENTS_ENTRY, json);
}

async function readPackEntry(zip) {
  const entry = zip.file(PACK_AGENTS_ENTRY);
  return entry ? await entry.async("string") : "";
}

/**
 * Collect the agents referenced by the given sessions.
 * @param {object} agentRepo AgentRepository
 * @param {object|null} characterRepo CharacterWorldsRepository (role cards)
 * @param {Array<{sessionId:string, ownerScope:string}>} sessions
 * @param {{includeRoleCards?: boolean}} options
 */
function collectAgentsForExport(agentRepo, characterRepo, sessions, { includeRoleCards = false } = {}) {
  const agents = [];
  const seen = new Set();
  for (const { sessionId, ownerScope } of Array.isArray(sessions) ? sessions : []) {
    let binding;
    try { binding = agentRepo.getBinding(sessionId, ownerScope); } catch { continue; }
    if (!binding?.agentRevisionId || seen.has(binding.agentRevisionId)) continue;
    const revision = agentRepo.getRevision(ownerScope, binding.agentRevisionId);
    if (!revision?.definition) continue;
    seen.add(revision.id);
    if (agents.length >= MAX_PACK_AGENTS) break;
    const definition = JSON.parse(JSON.stringify(revision.definition));
    let roleCard = null;
    if (definition.role && !definition.role.officialCharacterId) {
      if (includeRoleCards && characterRepo) {
        const revisionId = definition.role.characterRevisionId
          || characterRepo.getCharacter?.(ownerScope, definition.role.characterEntityId)?.currentRevisionId;
        const card = revisionId ? characterRepo.getRevision?.(ownerScope, revisionId) : null;
        if (card?.canonical) roleCard = { canonical: card.canonical };
      }
      definition.role = null;
    }
    agents.push({
      sourceRevisionId: revision.id,
      displayName: definition.name,
      definition,
      ...(roleCard ? { roleCard } : {}),
      source: { kind: revision.source?.kind || "created", ...(revision.source?.officialId ? { officialId: revision.source.officialId } : {}) },
    });
  }
  return { agents };
}

function packAgentsSection(collected) {
  const section = {
    schemaVersion: PACK_SCHEMA_VERSION,
    agents: (collected?.agents || []).map((agent) => ({
      displayName: agent.displayName,
      definition: agent.definition,
      ...(agent.roleCard ? { roleCard: agent.roleCard } : {}),
      source: agent.source,
    })),
  };
  const json = section.agents.length ? JSON.stringify(section) : "";
  if (Buffer.byteLength(json, "utf8") > MAX_PACK_JSON_BYTES) {
    throw Object.assign(new Error("agents section exceeds size limit"), { code: "AGENT_PACK_TOO_LARGE" });
  }
  return { json, count: section.agents.length };
}

function unpackAgentsSection(text) {
  const raw = String(text || "");
  if (!raw.trim()) return { schemaVersion: PACK_SCHEMA_VERSION, agents: [] };
  if (Buffer.byteLength(raw, "utf8") > MAX_PACK_JSON_BYTES) {
    throw Object.assign(new Error("agents section exceeds size limit"), { code: "AGENT_PACK_TOO_LARGE" });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error("agents section corrupt"), { code: "AGENT_PACK_CORRUPT" }); }
  if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.schemaVersion)) {
    throw Object.assign(new Error("agents section invalid"), { code: "AGENT_PACK_INVALID" });
  }
  if (parsed.schemaVersion > PACK_SCHEMA_VERSION) throw Object.assign(new Error("agents section too new"), { code: "AGENT_PACK_TOO_NEW" });
  return { schemaVersion: parsed.schemaVersion, agents: Array.isArray(parsed.agents) ? parsed.agents.slice(0, MAX_PACK_AGENTS) : [] };
}

function canonicalHashOf(canonical) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
}

/** Reuse an identical local character (by canonical hash) or create one. */
function importRoleCard(characterRepo, ownerScope, roleCard, importedFrom) {
  const canonical = roleCard?.canonical;
  if (!canonical || typeof canonical !== "object") return null;
  if (Buffer.byteLength(stableJson(canonical), "utf8") > MAX_ROLE_CARD_BYTES) {
    throw Object.assign(new Error("role card exceeds size limit"), { code: "AGENT_ROLE_CARD_TOO_LARGE" });
  }
  const hash = canonicalHashOf(canonical);
  const existing = characterRepo.db?.get?.(
    `SELECT r.entity_id FROM character_revisions r
     JOIN character_entities e ON e.id = r.entity_id AND e.owner_scope = r.owner_scope
     WHERE r.owner_scope = ? AND r.canonical_hash = ? AND e.archived_at IS NULL
     ORDER BY r.created_at ASC LIMIT 1`,
    ownerScope, hash,
  );
  if (existing?.entity_id) return { characterEntityId: existing.entity_id, reused: true };
  const created = characterRepo.createCharacter({
    ownerScope,
    canonical,
    source: { kind: "imported", format: "lily", container: "json", importedFrom: String(importedFrom || "workspace-pack") },
  });
  return { characterEntityId: created.entity.id, reused: false };
}

/**
 * Import a pack section into the owner's library.
 * @returns {{ok:true, imported:Array, skipped:Array, errors:Array}}
 */
function importAgentsPack(agentRepo, characterRepo, ownerScope, section, { importedFrom = "workspace-pack" } = {}) {
  const imported = [];
  const skipped = [];
  const errors = [];
  const existingHashes = new Map();
  for (const entity of agentRepo.listAgents(ownerScope, { includeArchived: true })) {
    const revision = entity.currentRevisionId ? agentRepo.getRevision(ownerScope, entity.currentRevisionId) : null;
    if (revision?.definitionHash) existingHashes.set(revision.definitionHash, entity.id);
  }
  for (const [index, entry] of (section?.agents || []).entries()) {
    try {
      const definition = normalizeAgentDefinition({ ...(entry?.definition || {}), role: entry?.definition?.role?.officialCharacterId ? entry.definition.role : null });
      if (entry?.roleCard && characterRepo) {
        const role = importRoleCard(characterRepo, ownerScope, entry.roleCard, importedFrom);
        if (role) definition.role = { characterEntityId: role.characterEntityId };
      }
      const hash = agentDefinitionHash(definition);
      if (existingHashes.has(hash)) {
        skipped.push({ index, displayName: definition.name, reason: "duplicate", agentId: existingHashes.get(hash) });
        continue;
      }
      const created = agentRepo.createAgent({
        ownerScope,
        definition,
        source: { kind: AGENT_SOURCE_KINDS.imported, importedFrom: String(importedFrom || "") },
      });
      existingHashes.set(hash, created.entity.id);
      imported.push({ index, agentId: created.entity.id, revisionId: created.revision.id, displayName: definition.name });
    } catch (error) {
      errors.push({ index, code: error?.code || "AGENT_IMPORT_FAILED", displayName: String(entry?.displayName || "") });
    }
  }
  return { ok: true, imported, skipped, errors };
}

module.exports = {
  PACK_AGENTS_ENTRY,
  PACK_SCHEMA_VERSION,
  MAX_PACK_AGENTS,
  writePackEntry,
  readPackEntry,
  collectAgentsForExport,
  packAgentsSection,
  unpackAgentsSection,
  importAgentsPack,
};
