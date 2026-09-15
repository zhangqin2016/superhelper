"use strict";

/**
 * Agent definition model — the ONE validated shape every producer (official
 * catalog, library editor, agent draft tool, pack import, server
 * distribution) must pass through before anything is stored or applied.
 *
 * Pure: no I/O, no Electron. Every rejection is a coded error
 * (AGENT_DEFINITION_INVALID with `field`, AGENT_DEFINITION_TOO_LARGE) so the
 * IPC guard, the broker tool and the importer all speak the same codes.
 *
 * The normalized definition is COMPLETE: every dimension is present with an
 * explicit "inherit"/empty value, so consumers never branch on undefined.
 */

const crypto = require("node:crypto");
const util = require("node:util");
const C = require("./constants");

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Control characters except \t \n \r; invisible format chars are escaped by
// the persistence layer on write, so they are not rejected here.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ID_FORBIDDEN = /[\u0000-\u001f\u007f\s]/;

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function invalid(field, message) {
  return codedError("AGENT_DEFINITION_INVALID", message || `Invalid agent field: ${field}`, { field });
}

function plainObject(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || util.types.isProxy(value)) throw invalid(field, `${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(field, `${field} must be a plain object`);
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw invalid(field, `${field} has a symbol key`);
    if (DANGEROUS_KEYS.has(key)) throw invalid(field, `${field} has a dangerous key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid(field, `${field}.${key} must be a data property`);
    out[key] = descriptor.value;
  }
  return out;
}

function text(value, field, maxChars, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalid(field, `${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw invalid(field, `${field} must be a string`);
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (required && !cleaned) throw invalid(field, `${field} is required`);
  if (cleaned.length > maxChars) throw invalid(field, `${field} exceeds ${maxChars} characters`);
  return cleaned;
}

function stringList(value, field, { max, maxChars, pattern = null, lowercase = false } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(field, `${field} must be an array`);
  if (value.length > max) throw invalid(field, `${field} exceeds ${max} entries`);
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw invalid(field, `${field} entries must be strings`);
    const item = (lowercase ? raw.toLowerCase() : raw).replace(CONTROL_CHARS, "").trim();
    if (!item) continue;
    if (item.length > maxChars) throw invalid(field, `${field} entry exceeds ${maxChars} characters`);
    if (pattern && !pattern.test(item)) throw invalid(field, `${field} entry has an invalid format: ${item.slice(0, 40)}`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !C.ID_PATTERN.test(value)) throw invalid(field, `${field} must be an id`);
  return value;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** role: exactly one reference kind, or null (native Lily voice). */
function normalizeRole(value) {
  if (value === undefined || value === null) return null;
  const role = plainObject(value, "role");
  const officialCharacterId = optionalId(role.officialCharacterId, "role.officialCharacterId");
  const characterEntityId = optionalId(role.characterEntityId, "role.characterEntityId");
  const characterRevisionId = optionalId(role.characterRevisionId, "role.characterRevisionId");
  const refs = [officialCharacterId, characterEntityId, characterRevisionId].filter(Boolean);
  if (refs.length === 0) return null;
  if (refs.length > 1) throw invalid("role", "role must reference exactly one of officialCharacterId, characterEntityId, characterRevisionId");
  return {
    ...(officialCharacterId ? { officialCharacterId } : {}),
    ...(characterEntityId ? { characterEntityId } : {}),
    ...(characterRevisionId ? { characterRevisionId } : {}),
  };
}

function normalizeSkills(value) {
  const skills = plainObject(value, "skills");
  const opts = { max: C.MAX_AGENT_SKILL_IDS, maxChars: 100, pattern: C.SKILL_ID_PATTERN, lowercase: true };
  const required = stringList(skills.required, "skills.required", opts);
  const enabled = stringList(skills.enabled, "skills.enabled", opts);
  // A required skill is always also enabled.
  for (const id of required) if (!enabled.includes(id)) enabled.push(id);
  return { required, enabled };
}

function normalizeKnowledge(value) {
  const knowledge = plainObject(value, "knowledge");
  return {
    packs: stringList(knowledge.packs, "knowledge.packs", { max: C.MAX_AGENT_KNOWLEDGE_PACKS, maxChars: 64, pattern: C.PACK_ID_PATTERN, lowercase: true }),
    guidance: text(knowledge.guidance, "knowledge.guidance", C.MAX_AGENT_KNOWLEDGE_GUIDANCE_CHARS),
  };
}

function normalizeModel(value) {
  const model = plainObject(value, "model");
  const raw = model.presetId;
  if (raw === undefined || raw === null || raw === "" || raw === "inherit") return { presetId: "" };
  if (typeof raw !== "string" || raw.length > C.MAX_AGENT_ID_CHARS || ID_FORBIDDEN.test(raw)) {
    throw invalid("model.presetId", "model.presetId must be a model id or \"inherit\"");
  }
  return { presetId: raw };
}

function normalizeTools(value) {
  const tools = plainObject(value, "tools");
  const opts = { max: C.MAX_AGENT_TOOL_NAMES, maxChars: C.MAX_AGENT_TOOL_NAME_CHARS, pattern: C.TOOL_NAME_PATTERN };
  return {
    mcpAllow: stringList(tools.mcpAllow, "tools.mcpAllow", opts),
    connectors: stringList(tools.connectors, "tools.connectors", opts),
    disallow: stringList(tools.disallow, "tools.disallow", opts),
  };
}

function normalizeAutonomy(value) {
  const autonomy = plainObject(value, "autonomy");
  const raw = autonomy.permissionModeId;
  if (raw === undefined || raw === null || raw === "") return { permissionModeId: "inherit" };
  if (typeof raw !== "string" || !C.AUTONOMY_MODES.includes(raw)) {
    throw invalid("autonomy.permissionModeId", `autonomy.permissionModeId must be one of ${C.AUTONOMY_MODES.join(", ")}`);
  }
  return { permissionModeId: raw };
}

/** Automations are validated STRUCTURALLY here; the schedule itself is
 *  normalized by scheduled-task-portability at activation (single source of
 *  truth for schedule semantics). */
function normalizeAutomations(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("automations", "automations must be an array");
  if (value.length > C.MAX_AGENT_AUTOMATIONS) throw invalid("automations", `automations exceeds ${C.MAX_AGENT_AUTOMATIONS} entries`);
  return value.map((raw, index) => {
    const field = `automations[${index}]`;
    const item = plainObject(raw, field);
    const schedule = plainObject(item.schedule, `${field}.schedule`);
    if (typeof schedule.type !== "string" || !schedule.type) throw invalid(`${field}.schedule.type`, "automation schedule.type is required");
    return {
      title: text(item.title, `${field}.title`, 80),
      prompt: text(item.prompt, `${field}.prompt`, 4000, { required: true }),
      schedule: JSON.parse(JSON.stringify(schedule)),
      scheduleText: text(item.scheduleText, `${field}.scheduleText`, 120),
    };
  });
}

// ---------------------------------------------------------------------------
// Whole definition
// ---------------------------------------------------------------------------

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/**
 * Validate + normalize an agent definition. Throws coded errors; returns a
 * plain object with every dimension present.
 */
function normalizeAgentDefinition(input) {
  const raw = plainObject(input, "definition");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== C.AGENT_SCHEMA_VERSION) {
    throw invalid("schemaVersion", `Unsupported agent schemaVersion ${String(raw.schemaVersion)}`);
  }
  const definition = {
    schemaVersion: C.AGENT_SCHEMA_VERSION,
    name: text(raw.name, "name", C.MAX_AGENT_NAME_CHARS, { required: true }),
    description: text(raw.description, "description", C.MAX_AGENT_DESCRIPTION_CHARS),
    icon: text(raw.icon, "icon", C.MAX_AGENT_ICON_CHARS),
    tags: stringList(raw.tags, "tags", { max: C.MAX_AGENT_TAGS, maxChars: C.MAX_AGENT_TAG_CHARS }),
    role: normalizeRole(raw.role),
    starters: stringList(raw.starters, "starters", { max: C.MAX_AGENT_STARTERS, maxChars: C.MAX_AGENT_STARTER_CHARS }),
    skills: normalizeSkills(raw.skills),
    knowledge: normalizeKnowledge(raw.knowledge),
    model: normalizeModel(raw.model),
    tools: normalizeTools(raw.tools),
    autonomy: normalizeAutonomy(raw.autonomy),
    automations: normalizeAutomations(raw.automations),
  };
  const json = stableJson(definition);
  if (Buffer.byteLength(json, "utf8") > C.MAX_AGENT_DEFINITION_BYTES) {
    throw codedError("AGENT_DEFINITION_TOO_LARGE", `Agent definition exceeds ${C.MAX_AGENT_DEFINITION_BYTES} bytes`);
  }
  return definition;
}

function agentDefinitionHash(definition) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(definition)).digest("hex")}`;
}

/** Which dimensions this definition actually sets (non-inherit). */
function activeDimensions(definition) {
  const out = [];
  if (definition.role) out.push("role");
  if (definition.skills.enabled.length) out.push("skills");
  if (definition.knowledge.packs.length || definition.knowledge.guidance) out.push("knowledge");
  if (definition.autonomy.permissionModeId !== "inherit") out.push("autonomy");
  if (definition.model.presetId) out.push("model");
  if (definition.tools.disallow.length || definition.tools.mcpAllow.length || definition.tools.connectors.length) out.push("tools");
  if (definition.automations.length) out.push("automations");
  return out;
}

/** True when activating this definition changes the shared serve config.
 *  Within `tools`, only `disallow` is enforced in the serve permission map;
 *  mcpAllow/connectors are advisory and ride the hot guidance path. */
function hasColdDimensions(definition) {
  return activeDimensions(definition).some((dimension) => {
    if (C.DIMENSION_PATHS[dimension] !== "cold") return false;
    if (dimension === "tools") return definition.tools.disallow.length > 0;
    return true;
  });
}

/** Bounded, renderer-safe projection: never leaks owner scope or paths. */
function summarizeAgentDefinition(definition) {
  return {
    schemaVersion: definition.schemaVersion,
    name: definition.name,
    description: definition.description,
    icon: definition.icon,
    tags: [...definition.tags],
    role: definition.role ? { ...definition.role } : null,
    starters: [...definition.starters],
    skills: { required: [...definition.skills.required], enabled: [...definition.skills.enabled] },
    knowledge: { packs: [...definition.knowledge.packs], guidance: definition.knowledge.guidance },
    model: { presetId: definition.model.presetId },
    tools: {
      mcpAllow: [...definition.tools.mcpAllow],
      connectors: [...definition.tools.connectors],
      disallow: [...definition.tools.disallow],
    },
    autonomy: { permissionModeId: definition.autonomy.permissionModeId },
    automations: definition.automations.map((item) => ({ ...item, schedule: { ...item.schedule } })),
    dimensions: activeDimensions(definition),
    cold: hasColdDimensions(definition),
  };
}

module.exports = {
  codedError,
  stableJson,
  normalizeAgentDefinition,
  agentDefinitionHash,
  activeDimensions,
  hasColdDimensions,
  summarizeAgentDefinition,
};
