// Agent definition validator — ESM port of the desktop client's
// src/main/agents/agent-definition.js (+ constants.js). SAME rules, SAME
// limits, SAME error codes (AGENT_DEFINITION_INVALID with `field`,
// AGENT_DEFINITION_TOO_LARGE), so a definition the server accepts is exactly
// one the client will accept on install, and vice versa. Keep the two in sync:
// server/scripts/test-agent-packages-logic.mjs pins the parity cases.
//
// Pure: no I/O, no database.

import crypto from "node:crypto";
import util from "node:util";

// --- constants (mirror src/main/agents/constants.js) -----------------------

export const AGENT_SCHEMA_VERSION = 1;
export const MAX_AGENT_DEFINITION_BYTES = 256 * 1024;
export const MAX_AGENT_NAME_CHARS = 120;
export const MAX_AGENT_DESCRIPTION_CHARS = 2000;
export const MAX_AGENT_ICON_CHARS = 16;
export const MAX_AGENT_TAGS = 16;
export const MAX_AGENT_TAG_CHARS = 64;
export const MAX_AGENT_STARTERS = 8;
export const MAX_AGENT_STARTER_CHARS = 200;
export const MAX_AGENT_SKILL_IDS = 64;
export const MAX_AGENT_KNOWLEDGE_PACKS = 8;
export const MAX_AGENT_KNOWLEDGE_GUIDANCE_CHARS = 4000;
export const MAX_AGENT_TOOL_NAMES = 32;
export const MAX_AGENT_TOOL_NAME_CHARS = 96;
export const MAX_AGENT_AUTOMATIONS = 8;
export const MAX_AGENT_ID_CHARS = 128;

export const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]{1,99}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:*-]{0,95}$/;
export const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const AUTONOMY_MODES = Object.freeze(["inherit", "plan", "ask", "full"]);

const DIMENSION_PATHS = Object.freeze({
  role: "hot",
  skills: "hot",
  knowledge: "hot",
  autonomy: "hot",
  model: "cold",
  tools: "cold",
  automations: "independent",
});

// --- primitives ------------------------------------------------------------

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Control characters except \t \n \r.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ID_FORBIDDEN = /[\u0000-\u001f\u007f\s]/;

export function codedError(code, message, details = {}) {
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
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid(field, `${field} must be an id`);
  return value;
}

// --- dimensions ------------------------------------------------------------

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
  const opts = { max: MAX_AGENT_SKILL_IDS, maxChars: 100, pattern: SKILL_ID_PATTERN, lowercase: true };
  const required = stringList(skills.required, "skills.required", opts);
  const enabled = stringList(skills.enabled, "skills.enabled", opts);
  for (const id of required) if (!enabled.includes(id)) enabled.push(id);
  return { required, enabled };
}

function normalizeKnowledge(value) {
  const knowledge = plainObject(value, "knowledge");
  return {
    packs: stringList(knowledge.packs, "knowledge.packs", { max: MAX_AGENT_KNOWLEDGE_PACKS, maxChars: 64, pattern: PACK_ID_PATTERN, lowercase: true }),
    guidance: text(knowledge.guidance, "knowledge.guidance", MAX_AGENT_KNOWLEDGE_GUIDANCE_CHARS),
  };
}

function normalizeModel(value) {
  const model = plainObject(value, "model");
  const raw = model.presetId;
  if (raw === undefined || raw === null || raw === "" || raw === "inherit") return { presetId: "" };
  if (typeof raw !== "string" || raw.length > MAX_AGENT_ID_CHARS || ID_FORBIDDEN.test(raw)) {
    throw invalid("model.presetId", 'model.presetId must be a model id or "inherit"');
  }
  return { presetId: raw };
}

function normalizeTools(value) {
  const tools = plainObject(value, "tools");
  const opts = { max: MAX_AGENT_TOOL_NAMES, maxChars: MAX_AGENT_TOOL_NAME_CHARS, pattern: TOOL_NAME_PATTERN };
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
  if (typeof raw !== "string" || !AUTONOMY_MODES.includes(raw)) {
    throw invalid("autonomy.permissionModeId", `autonomy.permissionModeId must be one of ${AUTONOMY_MODES.join(", ")}`);
  }
  return { permissionModeId: raw };
}

function normalizeAutomations(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("automations", "automations must be an array");
  if (value.length > MAX_AGENT_AUTOMATIONS) throw invalid("automations", `automations exceeds ${MAX_AGENT_AUTOMATIONS} entries`);
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

// --- whole definition ------------------------------------------------------

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/** Validate + normalize. Throws coded errors; returns a complete definition. */
export function normalizeAgentDefinition(input) {
  const raw = plainObject(input, "definition");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== AGENT_SCHEMA_VERSION) {
    throw invalid("schemaVersion", `Unsupported agent schemaVersion ${String(raw.schemaVersion)}`);
  }
  const definition = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    name: text(raw.name, "name", MAX_AGENT_NAME_CHARS, { required: true }),
    description: text(raw.description, "description", MAX_AGENT_DESCRIPTION_CHARS),
    icon: text(raw.icon, "icon", MAX_AGENT_ICON_CHARS),
    tags: stringList(raw.tags, "tags", { max: MAX_AGENT_TAGS, maxChars: MAX_AGENT_TAG_CHARS }),
    role: normalizeRole(raw.role),
    starters: stringList(raw.starters, "starters", { max: MAX_AGENT_STARTERS, maxChars: MAX_AGENT_STARTER_CHARS }),
    skills: normalizeSkills(raw.skills),
    knowledge: normalizeKnowledge(raw.knowledge),
    model: normalizeModel(raw.model),
    tools: normalizeTools(raw.tools),
    autonomy: normalizeAutonomy(raw.autonomy),
    automations: normalizeAutomations(raw.automations),
  };
  const json = stableJson(definition);
  if (Buffer.byteLength(json, "utf8") > MAX_AGENT_DEFINITION_BYTES) {
    throw codedError("AGENT_DEFINITION_TOO_LARGE", `Agent definition exceeds ${MAX_AGENT_DEFINITION_BYTES} bytes`);
  }
  return definition;
}

export function agentDefinitionHash(definition) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(definition)).digest("hex")}`;
}

/** Which dimensions this definition actually sets (non-inherit). */
export function activeDimensions(definition) {
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

export function hasColdDimensions(definition) {
  return activeDimensions(definition).some((dimension) => DIMENSION_PATHS[dimension] === "cold");
}
