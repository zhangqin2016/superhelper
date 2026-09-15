"use strict";

/**
 * 智能体（Agent）管理 — shared constants.
 *
 * An agent is a HOST-OWNED bundle that binds the seven behaviour dimensions
 * Lily already has (role/instructions, skills, knowledge, autonomy, model,
 * tools, automations) to one conversation. It is configuration, never prompt
 * text: the role card stays a lower-authority narrative suffix, everything
 * else is applied by the host through the existing per-dimension setters.
 * See docs/agent-management-design.md.
 */

const AGENT_SCHEMA_VERSION = 1;
const AGENT_BINDING_SCHEMA_VERSION = 1;

// Whole-definition byte cap (stableJson). Generous for text guidance, far
// below anything that could stress the IPC or the guide budget.
const MAX_AGENT_DEFINITION_BYTES = 256 * 1024;
const MAX_AGENT_NAME_CHARS = 120;
const MAX_AGENT_DESCRIPTION_CHARS = 2000;
const MAX_AGENT_ICON_CHARS = 16;
const MAX_AGENT_TAGS = 16;
const MAX_AGENT_TAG_CHARS = 64;
const MAX_AGENT_STARTERS = 8;
const MAX_AGENT_STARTER_CHARS = 200;
const MAX_AGENT_SKILL_IDS = 64;
const MAX_AGENT_KNOWLEDGE_PACKS = 8;
const MAX_AGENT_KNOWLEDGE_GUIDANCE_CHARS = 4000;
const MAX_AGENT_TOOL_NAMES = 32;
const MAX_AGENT_TOOL_NAME_CHARS = 96;
const MAX_AGENT_AUTOMATIONS = 8;
const MAX_AGENT_ID_CHARS = 128;
const MAX_AGENT_BINDING_BYTES = 64 * 1024;

const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]{1,99}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:*-]{0,95}$/;
const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const AUTONOMY_MODES = Object.freeze(["inherit", "plan", "ask", "full"]);

// Source kinds recorded on revisions (SQL-queryable provenance).
const AGENT_SOURCE_KINDS = Object.freeze({
  official: "official",
  created: "created",
  edited: "edited",
  imported: "imported",
  agentDraft: "agent_draft",
  distributed: "distributed",
});

// Dimension → delivery path. "hot" dimensions ride the per-prompt guide /
// host-side policy and apply on the next message; "cold" dimensions live in
// the shared serve config, so they only apply when the engine session is
// (re)built — we apply them at activation time and never mid-conversation.
const DIMENSION_PATHS = Object.freeze({
  role: "hot",
  skills: "hot",
  knowledge: "hot",
  autonomy: "hot",
  model: "cold",
  tools: "cold",
  automations: "independent",
});

// Emergency kill switch. LILY_AGENTS=0 hides the library, refuses new
// activations, and makes every agent-derived policy read as "no agent" —
// existing bindings stay stored and readable so nothing is lost.
function agentsEnabled() {
  return process.env.LILY_AGENTS !== "0";
}

// Maximum number of distinct live shared-serve profiles we let agents fork
// (decision 2026-09-14). Beyond it, cold dimensions degrade to inherit.
function serveForkLimit() {
  const raw = Number.parseInt(process.env.LILY_AGENT_SERVE_FORK_LIMIT || "", 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : 3;
}

module.exports = {
  AGENT_SCHEMA_VERSION,
  AGENT_BINDING_SCHEMA_VERSION,
  MAX_AGENT_DEFINITION_BYTES,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_DESCRIPTION_CHARS,
  MAX_AGENT_ICON_CHARS,
  MAX_AGENT_TAGS,
  MAX_AGENT_TAG_CHARS,
  MAX_AGENT_STARTERS,
  MAX_AGENT_STARTER_CHARS,
  MAX_AGENT_SKILL_IDS,
  MAX_AGENT_KNOWLEDGE_PACKS,
  MAX_AGENT_KNOWLEDGE_GUIDANCE_CHARS,
  MAX_AGENT_TOOL_NAMES,
  MAX_AGENT_TOOL_NAME_CHARS,
  MAX_AGENT_AUTOMATIONS,
  MAX_AGENT_ID_CHARS,
  MAX_AGENT_BINDING_BYTES,
  SKILL_ID_PATTERN,
  TOOL_NAME_PATTERN,
  PACK_ID_PATTERN,
  ID_PATTERN,
  AUTONOMY_MODES,
  AGENT_SOURCE_KINDS,
  DIMENSION_PATHS,
  agentsEnabled,
  serveForkLimit,
};
