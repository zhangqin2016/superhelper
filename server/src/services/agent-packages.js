// Agent packages — server-distributed 智能体 definitions (design §3.4 P2).
//
// Mirrors services/skill-packages.js: pure normalize / quality-gate / registry
// helpers, plus thin DB helpers that take `db` as a parameter so this module
// can be imported (and unit-tested) without DATABASE_URL.
//
// Every rejection is a coded error:
//   AGENT_DEFINITION_INVALID {field} / AGENT_DEFINITION_TOO_LARGE  (validator parity)
//   AGENT_PACKAGE_INVALID {field}                                  (envelope fields)
//   AGENT_ROLE_CARD_INVALID / AGENT_ROLE_CARD_TOO_LARGE            (embedded role)
//   AGENT_PACKAGE_CONFLICT                                          (unique publication)

import {
  AUTONOMY_MODES,
  ID_PATTERN,
  MAX_AGENT_DEFINITION_BYTES,
  MAX_AGENT_STARTERS,
  activeDimensions,
  codedError,
  normalizeAgentDefinition,
  stableJson,
} from "./agent-definition.js";
import { compareVersions } from "./skill-packages.js";

export const AGENT_SCOPE_TYPES = Object.freeze(["global", "organization"]);
export const MAX_ROLE_CARD_BYTES = 1024 * 1024;
export const DEFAULT_AGENT_PUBLISHER = "Lily Workbench";
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function invalidPackage(field, message) {
  return codedError("AGENT_PACKAGE_INVALID", message || `Invalid agent package field: ${field}`, { field });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "on", "yes"].includes(String(value).toLowerCase());
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidPackage(field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalidPackage(field, `${field} exceeds ${max} characters`);
  return trimmed || null;
}

/** jsonb columns arrive parsed from pg; tolerate strings for fixtures/tests. */
export function parseJsonColumn(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value ?? null;
}

// --- role card ---------------------------------------------------------------

/**
 * An embedded role: `{ canonical: {...} }` where canonical is a flat character
 * canonical object. The server does not interpret it — it only bounds it so a
 * distributed agent can carry its role without referencing a local id.
 */
export function normalizeRoleCard(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = parseJsonColumn(raw);
  if (!isPlainObject(value)) throw codedError("AGENT_ROLE_CARD_INVALID", "roleCard must be an object", { field: "roleCard" });
  if (!isPlainObject(value.canonical)) {
    throw codedError("AGENT_ROLE_CARD_INVALID", "roleCard.canonical must be an object", { field: "roleCard.canonical" });
  }
  const canonical = JSON.parse(JSON.stringify(value.canonical));
  if (Buffer.byteLength(stableJson(canonical), "utf8") > MAX_ROLE_CARD_BYTES) {
    throw codedError("AGENT_ROLE_CARD_TOO_LARGE", `roleCard exceeds ${MAX_ROLE_CARD_BYTES} bytes`, { field: "roleCard" });
  }
  return { canonical };
}

// --- package envelope --------------------------------------------------------

/**
 * Validate + normalize a publish request. `scope` may be forced by the caller
 * (enterprise routes pin scopeType/organizationId from the URL; the admin
 * route takes them from the body).
 */
export function normalizeAgentPackageInput(raw, { scopeType, organizationId } = {}) {
  const input = isPlainObject(raw) ? raw : {};
  const agentId = String(input.agentId ?? input.agent_id ?? "").trim();
  if (!agentId || !ID_PATTERN.test(agentId)) throw invalidPackage("agentId", "agentId must be an id (letters, digits, _ . : -; max 128)");
  const version = String(input.version ?? "").trim();
  if (!version || !VERSION_RE.test(version)) throw invalidPackage("version", "version is required (e.g. 1.0.0)");
  const channel = String(input.channel ?? "stable").trim().toLowerCase() || "stable";
  if (!CHANNEL_RE.test(channel)) throw invalidPackage("channel", "channel must be lowercase kebab-case");

  const resolvedScopeType = String(scopeType ?? input.scopeType ?? input.scope_type ?? "global").trim() || "global";
  if (!AGENT_SCOPE_TYPES.includes(resolvedScopeType)) throw invalidPackage("scopeType", `scopeType must be one of ${AGENT_SCOPE_TYPES.join(", ")}`);
  const resolvedOrganizationId = optionalText(organizationId ?? input.organizationId ?? input.organization_id ?? null, "organizationId", 120);
  if (resolvedScopeType === "organization" && !resolvedOrganizationId) throw invalidPackage("organizationId", "organizationId is required for organization scope");
  if (resolvedScopeType === "global" && resolvedOrganizationId) throw invalidPackage("organizationId", "organizationId must be empty for global scope");

  const definition = normalizeAgentDefinition(parseJsonColumn(input.definition));
  const roleCard = normalizeRoleCard(input.roleCard ?? input.role_card);

  return {
    agentId,
    version,
    channel,
    scopeType: resolvedScopeType,
    organizationId: resolvedScopeType === "organization" ? resolvedOrganizationId : null,
    enabled: bool(input.enabled, true),
    featured: bool(input.featured, false),
    displayInCatalog: bool(input.displayInCatalog ?? input.display_in_catalog, true),
    publisher: optionalText(input.publisher, "publisher", 120) || DEFAULT_AGENT_PUBLISHER,
    definition,
    roleCard,
    minAppVersion: optionalText(input.minAppVersion ?? input.min_app_version, "minAppVersion", 40),
  };
}

// --- quality gate ------------------------------------------------------------

/**
 * Publish gate. Runs on the NORMALIZED input, so structural errors were already
 * thrown by the validator; this catches "valid but not distributable" cases and
 * returns them all at once, by field, for the admin UI.
 */
export function evaluateAgentPackageQuality(input) {
  const issues = [];
  const push = (field, code, message) => issues.push({ field, code, message });
  const definition = input?.definition;
  if (!isPlainObject(definition)) {
    push("definition", "DEFINITION_REQUIRED", "definition is required");
    return { ok: false, issues };
  }

  if (!String(definition.name || "").trim()) push("name", "NAME_REQUIRED", "Agent name is required");
  if (!String(definition.description || "").trim()) {
    push("description", "DESCRIPTION_REQUIRED", "Description must explain what this agent is for");
  }

  const dimensions = Array.isArray(definition.skills?.enabled) ? activeDimensions(definition) : [];
  if (!dimensions.length && !input.roleCard) {
    push("definition", "NO_DIMENSIONS", "Set at least one dimension (role, skills, knowledge, autonomy, model, tools or automations) or embed a roleCard");
  }

  const mode = definition.autonomy?.permissionModeId;
  if (mode !== undefined && !AUTONOMY_MODES.includes(mode)) {
    push("autonomy.permissionModeId", "UNKNOWN_AUTONOMY", `autonomy.permissionModeId must be one of ${AUTONOMY_MODES.join(", ")}`);
  }

  // Distribution rule: local ids never travel. A distributed agent references
  // its role by officialCharacterId, or carries the role itself as a roleCard.
  const role = definition.role;
  if (role && (role.characterEntityId || role.characterRevisionId)) {
    push("role", "LOCAL_ROLE_REFERENCE", "role.characterEntityId / characterRevisionId are local ids; publish with role.officialCharacterId or an embedded roleCard");
  }
  if (role?.officialCharacterId && input.roleCard) {
    push("role", "ROLE_AMBIGUOUS", "Use either role.officialCharacterId or roleCard, not both");
  }

  if (Array.isArray(definition.starters) && definition.starters.length > MAX_AGENT_STARTERS) {
    push("starters", "TOO_MANY_STARTERS", `starters exceeds ${MAX_AGENT_STARTERS} entries`);
  }

  if (Buffer.byteLength(stableJson(definition), "utf8") > MAX_AGENT_DEFINITION_BYTES) {
    push("definition", "DEFINITION_TOO_LARGE", `definition exceeds ${MAX_AGENT_DEFINITION_BYTES} bytes`);
  }
  if (input.roleCard && Buffer.byteLength(stableJson(input.roleCard.canonical || {}), "utf8") > MAX_ROLE_CARD_BYTES) {
    push("roleCard", "ROLE_CARD_TOO_LARGE", `roleCard exceeds ${MAX_ROLE_CARD_BYTES} bytes`);
  }

  return { ok: issues.length === 0, issues };
}

// --- registry ------------------------------------------------------------------

function scopeKey(row) {
  return `${row.scope_type || "global"}:${row.organization_id || ""}`;
}

/** Newest enabled publication per (agentId, scope). */
export function newestAgentPackages(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row?.enabled) continue;
    const key = `${row.agent_id}|${scopeKey(row)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const order = compareVersions(row.version, existing.version);
    if (order > 0) byKey.set(key, row);
    else if (order === 0 && new Date(row.created_at || 0).getTime() > new Date(existing.created_at || 0).getTime()) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export function agentPackageToRegistryEntry(row) {
  const roleCard = parseJsonColumn(row.role_card);
  return {
    packageId: row.id,
    agentId: row.agent_id,
    version: row.version,
    channel: row.channel || "stable",
    scope: row.scope_type === "organization"
      ? { type: "organization", organizationId: row.organization_id }
      : { type: "global" },
    publisher: row.publisher || DEFAULT_AGENT_PUBLISHER,
    featured: Boolean(row.featured),
    displayInCatalog: row.display_in_catalog !== false,
    definition: parseJsonColumn(row.definition),
    ...(roleCard ? { roleCard } : {}),
    minAppVersion: row.min_app_version || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * Signed registry. `signer(payload)` is the detached signer the client already
 * trusts for effective config (signConfigPayload → Ed25519 over stableStringify);
 * it signs everything except `signature`. No signer → no signature field.
 */
export function buildAgentRegistry(rows = [], { channel = "stable", registryUrl = "", signer = null } = {}) {
  const payload = {
    schemaVersion: 1,
    publisher: DEFAULT_AGENT_PUBLISHER,
    registryUrl: registryUrl || null,
    channel,
    generatedAt: new Date().toISOString(),
    agents: newestAgentPackages(rows).map(agentPackageToRegistryEntry),
  };
  if (typeof signer !== "function") return payload;
  return { ...payload, signature: signer(payload) };
}

// --- effective-config selection (media-style, fail-open) -----------------------

function uniqueIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

/**
 * Resolve `config.agents = { available: [agentIds], default: agentId }` against
 * the agents actually published for this caller. PURELY ADDITIVE + FAIL-OPEN:
 *   - no `agents` block (every old profile) → config returned untouched, so the
 *     output is byte-identical to today;
 *   - `available` is intersected with the published set; `default` must be in
 *     the intersection or it is dropped;
 *   - an empty intersection removes the block entirely → old behavior, never an
 *     explicit "nothing allowed".
 * Copy-on-write: never mutates the input (it may be the shared default object).
 */
export function resolveAgentSelection(configCopy, availableAgentIds) {
  if (!isPlainObject(configCopy)) return configCopy;
  const block = configCopy.agents;
  if (!isPlainObject(block)) return configCopy;
  const published = new Set(uniqueIds(availableAgentIds));
  const available = uniqueIds(block.available).filter((id) => published.has(id));
  if (!available.length) {
    const { agents: _dropped, ...rest } = configCopy;
    return rest;
  }
  const agents = { ...block, available };
  const requestedDefault = String(block.default || "").trim();
  if (requestedDefault && available.includes(requestedDefault)) agents.default = requestedDefault;
  else delete agents.default;
  return { ...configCopy, agents };
}

// --- HTTP mapping (pure) --------------------------------------------------------------

const CODED_STATUS = {
  AGENT_DEFINITION_INVALID: 400,
  AGENT_DEFINITION_TOO_LARGE: 413,
  AGENT_PACKAGE_INVALID: 400,
  AGENT_ROLE_CARD_INVALID: 400,
  AGENT_ROLE_CARD_TOO_LARGE: 413,
  AGENT_PACKAGE_CONFLICT: 409,
};

/** {statusCode, body} for a coded validation error, or null to rethrow. */
export function agentPackageErrorResponse(error) {
  const statusCode = CODED_STATUS[error?.code];
  if (!statusCode) return null;
  return {
    statusCode,
    body: {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    },
  };
}

export function qualityGateResponse(quality) {
  return { statusCode: 400, body: { ok: false, code: "AGENT_QUALITY_GATE_FAILED", issues: quality.issues } };
}

// --- DB helpers (db injected) ----------------------------------------------------

function rowValues(input, { id, createdBy }) {
  return {
    id,
    agent_id: input.agentId,
    version: input.version,
    channel: input.channel,
    scope_type: input.scopeType,
    organization_id: input.organizationId,
    enabled: input.enabled,
    featured: input.featured,
    display_in_catalog: input.displayInCatalog,
    publisher: input.publisher,
    definition: JSON.stringify(input.definition),
    role_card: input.roleCard ? JSON.stringify(input.roleCard) : null,
    min_app_version: input.minAppVersion,
    created_by: createdBy || null,
  };
}

export async function findAgentPackage(db, id) {
  return db.selectFrom("agent_packages").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function listAgentPackages(db, { channel, scopeType, organizationId, enabledOnly = false, limit = 300 } = {}) {
  let query = db.selectFrom("agent_packages").selectAll();
  if (channel) query = query.where("channel", "=", channel);
  if (scopeType) query = query.where("scope_type", "=", scopeType);
  if (organizationId) query = query.where("organization_id", "=", organizationId);
  if (enabledOnly) query = query.where("enabled", "=", true);
  return query.orderBy("created_at", "desc").limit(limit).execute();
}

/** Enabled packages visible to a caller: global ∪ the caller's active orgs. */
export async function listVisibleAgentPackages(db, { channel, organizationIds = [] } = {}) {
  const orgIds = uniqueIds(organizationIds);
  let query = db.selectFrom("agent_packages").selectAll().where("enabled", "=", true);
  if (channel) query = query.where("channel", "=", channel);
  // An empty `in ()` is a Postgres syntax error — branch instead.
  query = orgIds.length
    ? query.where((eb) => eb.or([
      eb("scope_type", "=", "global"),
      eb.and([eb("scope_type", "=", "organization"), eb("organization_id", "in", orgIds)]),
    ]))
    : query.where("scope_type", "=", "global");
  return query.orderBy("created_at", "desc").limit(1000).execute();
}

export async function listAvailableAgentIds(db, { organizationIds = [] } = {}) {
  const rows = await listVisibleAgentPackages(db, { organizationIds });
  return uniqueIds(rows.map((row) => row.agent_id));
}

/**
 * Insert or update the publication keyed by (agentId, version, channel, scope).
 * Select-then-write keeps the statement plain; the unique index still guards a
 * race, which surfaces as AGENT_PACKAGE_CONFLICT instead of a bare 500.
 */
export async function upsertAgentPackage(db, input, { id, createdBy } = {}) {
  let existing = db
    .selectFrom("agent_packages")
    .select(["id"])
    .where("agent_id", "=", input.agentId)
    .where("version", "=", input.version)
    .where("channel", "=", input.channel)
    .where("scope_type", "=", input.scopeType);
  existing = input.organizationId
    ? existing.where("organization_id", "=", input.organizationId)
    : existing.where("organization_id", "is", null);
  const found = await existing.executeTakeFirst();
  try {
    if (found) {
      const { id: _id, created_by: _createdBy, ...updates } = rowValues(input, { id: found.id, createdBy });
      await db.updateTable("agent_packages").set({ ...updates, updated_at: new Date() }).where("id", "=", found.id).execute();
      return { id: found.id, created: false };
    }
    await db.insertInto("agent_packages").values(rowValues(input, { id, createdBy })).execute();
    return { id, created: true };
  } catch (error) {
    if (error?.code === "23505") throw codedError("AGENT_PACKAGE_CONFLICT", "This agent version is already published in this scope", { statusCode: 409 });
    throw error;
  }
}

export function normalizeAgentPackagePatch(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const patch = {};
  if (input.enabled !== undefined) patch.enabled = bool(input.enabled, true);
  if (input.featured !== undefined) patch.featured = bool(input.featured, false);
  if (input.displayInCatalog !== undefined) patch.display_in_catalog = bool(input.displayInCatalog, true);
  if (!Object.keys(patch).length) throw invalidPackage("patch", "at least one of enabled, featured, displayInCatalog is required");
  return patch;
}

export async function patchAgentPackage(db, id, patch) {
  const found = await findAgentPackage(db, id);
  if (!found) return null;
  await db.updateTable("agent_packages").set({ ...patch, updated_at: new Date() }).where("id", "=", id).execute();
  return { ...found, ...patch };
}
