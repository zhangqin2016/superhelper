"use strict";

/**
 * `lily_agent_draft` — the natural-language creation path for 智能体.
 *
 * The user says "做一个审合同的智能体"; the model designs the whole bundle
 * (role card + skills + knowledge + tools + autonomy + starters) and calls
 * this ONE tool. Invariants mirror lily_character_draft:
 *  - The agent never binds or activates anything. Drafts are inert library
 *    revisions with `agent_draft` provenance; activation is human-only
 *    (library / session control / receipt buttons).
 *  - Validation is exactly normalizeAgentDefinition + the character
 *    authoring service for an embedded role card — identical codes/limits to
 *    the IPC path, so the tool and the UI never disagree.
 *  - Results are metadata only ({ok, agentId, revisionId, revisionNumber}).
 *  - Fail closed on the kill switch (LILY_AGENTS=0) and on any resolution
 *    error; the role card additionally needs the Character Worlds policy.
 */

const { z } = require("zod");
const { agentsEnabled, AGENT_SOURCE_KINDS } = require("./constants");
const { normalizeAgentDefinition } = require("./agent-definition");
const { listKnowledgePacks } = require("./knowledge-packs");
const { boundedPayload, validId } = require("../ipc-character-guards");
const { normalizeCharacterWorldsContext } = require("../character-worlds/agent-draft-tools");

const MAX_DRAFT_PAYLOAD_BYTES = 1024 * 1024;
const UNAVAILABLE = "AGENTS_UNAVAILABLE";
const INVALID_INPUT = "INVALID_INPUT";
const CODED_ERROR_SHAPE = /^[A-Z][A-Z0-9_]{1,71}$/;
const AGENT_DRAFT_SOURCE = Object.freeze({ kind: AGENT_SOURCE_KINDS.agentDraft });
const ROLE_DRAFT_SOURCE = Object.freeze({ kind: "agent_draft", format: "lily", container: "json" });

const DESCRIPTION = [
  "Draft a new 智能体 (agent: a reusable bundle of role, skills, knowledge, tools, autonomy and starter prompts)",
  "with action=create, or revise one with action=revise (agentId + expectedBaseRevisionId).",
  "Design the COMPLETE bundle from the user's natural-language intent: a clear name and one-sentence",
  "description; 3-5 starter prompts in the user's language; the skills the job needs (use real installed",
  "skill ids from the guide, e.g. lily-document-query, anthropics-docx, lily-excel-data-analysis);",
  "knowledge.packs only from the known pack ids; knowledge.guidance as concrete working rules;",
  "tools.mcpAllow for tools it should prefer; autonomy.permissionModeId = inherit|plan|ask|full.",
  "For the role either reference an official character (role.officialCharacterId) or provide roleCard",
  "(a flat character canonical: name, description, personality, scenario, firstMessage, creatorNotes…)",
  "and this tool will create the character and link it. Never invent skill ids or pack ids.",
  "Explain the result in plain language, show what was designed, and ask the user to confirm before",
  "activating it in a conversation — activation is human-only. Do not claim anything was created unless",
  "this tool returns ok:true. On a validation error repair the named field and retry; on",
  "AGENT_REVISION_CONFLICT re-read the current revision. Never expose internal ids unless asked.",
].join(" ");

const DEFINITION_INPUT_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(64)).max(16).optional(),
  role: z.object({
    officialCharacterId: z.string().max(128).optional(),
    characterEntityId: z.string().max(128).optional(),
  }).optional(),
  starters: z.array(z.string().max(200)).max(8).optional(),
  skills: z.object({
    required: z.array(z.string().max(100)).max(64).optional(),
    enabled: z.array(z.string().max(100)).max(64).optional(),
  }).optional(),
  knowledge: z.object({
    packs: z.array(z.string().max(64)).max(8).optional(),
    guidance: z.string().max(4000).optional(),
  }).optional(),
  model: z.object({ presetId: z.string().max(128).optional() }).optional(),
  tools: z.object({
    mcpAllow: z.array(z.string().max(96)).max(32).optional(),
    connectors: z.array(z.string().max(96)).max(32).optional(),
    disallow: z.array(z.string().max(96)).max(32).optional(),
  }).optional(),
  autonomy: z.object({ permissionModeId: z.enum(["inherit", "plan", "ask", "full"]).optional() }).optional(),
  automations: z.array(z.object({
    title: z.string().max(80).optional(),
    prompt: z.string().min(1).max(4000),
    schedule: z.object({ type: z.string().min(1).max(32) }).passthrough(),
    scheduleText: z.string().max(120).optional(),
  })).max(8).optional(),
}).passthrough();

const ROLE_CARD_SCHEMA = z.object({
  name: z.string().min(1).max(512),
  description: z.string().max(100_000).optional(),
  personality: z.string().max(100_000).optional(),
  scenario: z.string().max(100_000).optional(),
  firstMessage: z.string().max(100_000).optional(),
  exampleDialogue: z.string().max(100_000).optional(),
  creatorNotes: z.string().max(100_000).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  tags: z.array(z.string().max(256)).max(64).optional(),
}).passthrough();

function repairHintFor(code, field) {
  if (code === "AGENT_DEFINITION_INVALID") return `Repair only the field \`${field || "definition"}\` and retry; keep every other field unchanged.`;
  if (code === "AGENT_DEFINITION_TOO_LARGE") return "Shorten knowledge.guidance and the description; the bundle must stay compact.";
  if (code === INVALID_INPUT) return "Call the tool with action and a flat definition object (name required); do not write a Markdown or JSON file as a substitute.";
  if (code === "CHARACTER_WORLDS_UNAVAILABLE") return "Role cards are unavailable right now; reference an official character with role.officialCharacterId or omit the role.";
  return "Repair only the reported problem and retry the native tool.";
}

function normalizeArgs(args) {
  const payload = boundedPayload(args, MAX_DRAFT_PAYLOAD_BYTES);
  if (payload === null || !Object.keys(payload).length) return null;
  const action = payload.action;
  if (action !== "create" && action !== "revise") return null;
  const definition = payload.definition;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  const roleCard = payload.roleCard && typeof payload.roleCard === "object" && !Array.isArray(payload.roleCard) ? payload.roleCard : null;
  if (action === "revise" && (!validId(payload.agentId) || !validId(payload.expectedBaseRevisionId))) return null;
  return { action, definition, roleCard, agentId: payload.agentId, expectedBaseRevisionId: payload.expectedBaseRevisionId };
}

/** Main-process assembly of the `agents` broker block (owner scope resolved
 *  where safeStorage works; the stdio subprocess only trusts a full block). */
function assembleAgentsBrokerBlock(deps = {}) {
  try {
    if (!agentsEnabled()) return { enabled: false };
    const ownerScope = typeof deps.resolveOwnerScope === "function"
      ? deps.resolveOwnerScope()
      : require("../character-worlds/owner-scope").resolveCharacterOwnerScope();
    if (typeof ownerScope !== "string" || !ownerScope) return { enabled: false };
    return { enabled: true, ownerScope };
  } catch {
    return { enabled: false };
  }
}

function normalizeAgentsContext(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || value.enabled !== true) return { enabled: false };
  const ownerScope = typeof value.ownerScope === "string" && value.ownerScope ? value.ownerScope : "";
  return ownerScope ? { enabled: true, ownerScope } : { enabled: false };
}

/** Lazy repository factory for the stdio broker subprocess. */
function createLazyAgentRepository() {
  let cached = null;
  return () => {
    if (cached) return cached;
    try {
      const { messageDbPath, blobStoreDir } = require("../config");
      const { MessageStore } = require("../store/message-store");
      cached = new MessageStore(messageDbPath(), blobStoreDir()).agents();
    } catch {
      cached = null;
    }
    return cached;
  };
}

function buildAgentDraftTool(deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : () => {};

  const enabled = (context) => {
    try {
      if (!agentsEnabled()) return false;
      const injected = normalizeAgentsContext(context?.agents);
      if (injected) return injected.enabled === true;
      return true;
    } catch {
      return false;
    }
  };

  const repositoryOf = (callDeps) => {
    const direct = callDeps?.agentRepository || deps.agentRepository;
    if (direct) return direct;
    const lazy = typeof callDeps?.resolveAgentRepository === "function"
      ? callDeps.resolveAgentRepository
      : typeof deps.resolveAgentRepository === "function" ? deps.resolveAgentRepository : null;
    try { return lazy ? lazy() || null : null; } catch { return null; }
  };

  const authoringOf = (callDeps) => {
    const direct = callDeps?.characterWorldsService?.authoring || callDeps?.characterAuthoringService
      || deps.characterWorldsService?.authoring || deps.characterAuthoringService;
    if (direct) return direct;
    const lazy = typeof callDeps?.resolveDraftAuthoring === "function"
      ? callDeps.resolveDraftAuthoring
      : typeof deps.resolveDraftAuthoring === "function" ? deps.resolveDraftAuthoring : null;
    try { return lazy ? lazy() || null : null; } catch { return null; }
  };

  const ownerOf = async (context, callDeps) => {
    const injected = normalizeAgentsContext(context?.agents) || normalizeCharacterWorldsContext(context?.characterWorlds);
    if (injected?.enabled === true) return injected.ownerScope;
    const resolver = callDeps?.resolveOwnerScope || deps.resolveOwnerScope;
    if (typeof resolver === "function") return resolver();
    return require("../character-worlds/owner-scope").resolveCharacterOwnerScope();
  };

  async function handler(args = {}, context = {}, callDeps = {}) {
    if (!enabled(context)) return { ok: false, error: UNAVAILABLE };
    const repository = repositoryOf(callDeps);
    if (!repository) return { ok: false, error: UNAVAILABLE };
    let owner = null;
    try { owner = await ownerOf(context, callDeps); } catch { owner = null; }
    if (typeof owner !== "string" || !owner) return { ok: false, error: "IMPORT_OWNER_UNAVAILABLE" };
    const input = normalizeArgs(args);
    if (!input) return { ok: false, error: INVALID_INPUT, repairHint: repairHintFor(INVALID_INPUT) };
    let previousOwnerResolver = null;
    let authoring = null;
    try {
      const definition = JSON.parse(JSON.stringify(input.definition));
      if (input.roleCard) {
        // Role cards ride the Character Worlds pipeline (policy + validation).
        const characterContext = normalizeCharacterWorldsContext(context?.characterWorlds);
        if (process.env.LILY_CHARACTER_WORLDS === "0" || (characterContext && characterContext.enabled !== true)) {
          return { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE", repairHint: repairHintFor("CHARACTER_WORLDS_UNAVAILABLE") };
        }
        authoring = authoringOf(callDeps);
        if (!authoring) return { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE", repairHint: repairHintFor("CHARACTER_WORLDS_UNAVAILABLE") };
        if (typeof authoring.resolveOwnerScope === "function") {
          previousOwnerResolver = authoring.resolveOwnerScope;
          authoring.resolveOwnerScope = async () => owner;
        }
        const created = await authoring.createCharacter({ ownerScope: owner, canonical: input.roleCard, source: ROLE_DRAFT_SOURCE });
        definition.role = { characterEntityId: created.entity.id };
      }
      // Validate BEFORE touching storage so the model gets the precise field.
      normalizeAgentDefinition(definition);
      const result = input.action === "create"
        ? repository.createAgent({ ownerScope: owner, definition, source: AGENT_DRAFT_SOURCE })
        : repository.createRevision({
          ownerScope: owner, agentId: input.agentId, expectedBaseRevisionId: input.expectedBaseRevisionId,
          definition, source: AGENT_DRAFT_SOURCE,
        });
      return {
        ok: true,
        agentId: result.entity.id,
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        ...(definition.role?.characterEntityId && input.roleCard ? { roleCharacterId: definition.role.characterEntityId } : {}),
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (CODED_ERROR_SHAPE.test(code)) {
        const failure = { ok: false, error: code, repairHint: repairHintFor(code, error.field) };
        if (typeof error.field === "string") failure.field = error.field;
        if (typeof error.message === "string" && error.message) failure.message = error.message.slice(0, 512);
        if (typeof error.currentRevisionId === "string") failure.currentRevisionId = error.currentRevisionId;
        return failure;
      }
      log("[agent-draft] unexpected failure:", error?.message || error);
      return { ok: false, error: UNAVAILABLE };
    } finally {
      if (previousOwnerResolver && authoring) authoring.resolveOwnerScope = previousOwnerResolver;
    }
  }

  return {
    id: "lily_agent_draft",
    name: "lily_agent_draft",
    group: "agents",
    requiredSkillIds: [],
    executionSurface: "tool_broker",
    mcpServerName: "lily_tool_broker",
    description: `${DESCRIPTION} Known knowledge pack ids: ${listKnowledgePacks().map((pack) => pack.id).join(", ") || "none"}.`,
    inputSchema: {
      action: z.enum(["create", "revise"]).describe("create a new agent draft, or revise an existing agent"),
      definition: DEFINITION_INPUT_SCHEMA.describe("the agent bundle: name (required), description, starters, role, skills, knowledge, tools, autonomy, model, automations"),
      roleCard: ROLE_CARD_SCHEMA.optional().describe("optional flat character canonical to create as this agent's role; omit when role.officialCharacterId is set"),
      agentId: z.string().min(1).max(128).optional().describe("required for revise: the library agent id"),
      expectedBaseRevisionId: z.string().min(1).max(128).optional().describe("required for revise: the revision id the draft is based on (CAS)"),
    },
    annotations: {},
    isAvailable: (context) => enabled(context),
    handler,
  };
}

module.exports = {
  MAX_DRAFT_PAYLOAD_BYTES,
  assembleAgentsBrokerBlock,
  normalizeAgentsContext,
  createLazyAgentRepository,
  buildAgentDraftTool,
};
