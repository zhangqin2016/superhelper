#!/usr/bin/env node
// `lily_agent_draft` broker tool: platform-scoped, kill-switch gated, creates
// INERT library revisions (never binds), validates through the exact
// definition model, creates an embedded role card through the character
// authoring service, returns metadata only, repairs by field on rejection.
// Run: node scripts/test-agent-draft-tool.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterWorldsRepository } = require("../src/main/character-worlds/repository.js");
const { CharacterAuthoringService } = require("../src/main/character-worlds/authoring-service.js");
const { buildAgentDraftTool, assembleAgentsBrokerBlock, normalizeAgentsContext } = require("../src/main/agents/agent-draft-tool.js");
const { buildBrokerTools, findBrokerTool } = require("../src/main/mcp/tool-broker-registry.js");

const OWNER = "profile:account:draft-owner";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-draft-tool-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const agentRepository = store.agents();
const characterRepository = new CharacterWorldsRepository(store);
const authoring = new CharacterAuthoringService({ repository: characterRepository, resolveOwnerScope: async () => OWNER });

const deps = {
  agentRepository,
  characterAuthoringService: authoring,
  resolveOwnerScope: async () => OWNER,
  characterWorldsPolicy: () => ({ enabled: true, reason: "test" }),
  log: () => {},
};
const tool = buildAgentDraftTool(deps);
const PLATFORM = { platformOnly: true, activeSkillIds: [], agents: { enabled: true, ownerScope: OWNER }, characterWorlds: { enabled: true, ownerScope: OWNER } };
const call = (args, context = PLATFORM) => tool.handler(args, context, deps);

try {
  await check("tool definition matches broker conventions and its name stays gateway-safe", async () => {
    assert.equal(tool.name, "lily_agent_draft");
    assert.equal(tool.group, "agents");
    assert.deepEqual(tool.requiredSkillIds, []);
    assert.equal(tool.mcpServerName, "lily_tool_broker");
    assert.ok(`lily_tool_broker_${tool.name}`.length <= 35, "prefixed MCP tool name must fit the 35-char gateway limit");
    assert.equal(tool.inputSchema.action.safeParse("create").success, true);
    assert.equal(tool.inputSchema.action.safeParse("activate").success, false, "there is no activate action — activation is human-only");
    assert.equal(tool.inputSchema.definition.safeParse({ name: "A", autonomy: { permissionModeId: "ask" } }).success, true);
    assert.equal(tool.inputSchema.definition.safeParse({ name: "A", autonomy: { permissionModeId: "yolo" } }).success, false);
    assert.match(tool.description, /never|human-only/i);
    assert.match(tool.description, /legal-cn-enterprise/, "known pack ids are advertised so the model never invents one");
  });

  await check("registry exposes it as a platform tool, gated by the kill switch", async () => {
    const names = (context) => buildBrokerTools(context, deps).map((entry) => entry.name);
    assert.ok(names(PLATFORM).includes("lily_agent_draft"));
    assert.ok(names({ sessionId: "s1", activeSkillIds: [] }).includes("lily_agent_draft"));
    assert.ok(!names({ activeSkillIds: [] }).includes("lily_agent_draft"), "no session and not platform → fails closed");
    process.env.LILY_AGENTS = "0";
    assert.ok(!names(PLATFORM).includes("lily_agent_draft"));
    assert.equal(findBrokerTool(PLATFORM, "lily_agent_draft", deps), null);
    delete process.env.LILY_AGENTS;
    assert.ok(!names({ ...PLATFORM, agents: { enabled: false } }).includes("lily_agent_draft"), "a disabled injected block hides the tool");
  });

  await check("broker block assembly: owner resolved main-side, disabled on kill switch or failure", async () => {
    assert.deepEqual(assembleAgentsBrokerBlock({ resolveOwnerScope: () => OWNER }), { enabled: true, ownerScope: OWNER });
    assert.deepEqual(assembleAgentsBrokerBlock({ resolveOwnerScope: () => { throw new Error("x"); } }), { enabled: false });
    assert.deepEqual(assembleAgentsBrokerBlock({ resolveOwnerScope: () => "" }), { enabled: false });
    process.env.LILY_AGENTS = "0";
    assert.deepEqual(assembleAgentsBrokerBlock({ resolveOwnerScope: () => OWNER }), { enabled: false });
    delete process.env.LILY_AGENTS;
    assert.equal(normalizeAgentsContext(undefined), null);
    assert.deepEqual(normalizeAgentsContext({ enabled: "true", ownerScope: OWNER }), { enabled: false });
    assert.deepEqual(normalizeAgentsContext({ enabled: true }), { enabled: false });
  });

  let created;
  await check("create with an official role stores an inert agent_draft revision (metadata only)", async () => {
    created = await call({
      action: "create",
      definition: {
        name: "审合同的小助手",
        description: "帮我审合同",
        role: { officialCharacterId: "lily-contract-reviewer" },
        starters: ["审一下这份合同"],
        skills: { required: ["lily-document-query"] },
        autonomy: { permissionModeId: "ask" },
      },
    });
    assert.equal(created.ok, true);
    assert.deepEqual(Object.keys(created).sort(), ["agentId", "ok", "revisionId", "revisionNumber"]);
    const revision = agentRepository.getRevision(OWNER, created.revisionId);
    assert.equal(revision.source.kind, "agent_draft");
    assert.equal(revision.definition.role.officialCharacterId, "lily-contract-reviewer");
    // nothing bound anywhere
    assert.equal(agentRepository.db.get("SELECT COUNT(*) AS n FROM agent_session_bindings").n, 0);
  });

  await check("create with roleCard creates the character through the authoring service and links it", async () => {
    const result = await call({
      action: "create",
      definition: { name: "带角色的助手", skills: { enabled: ["anthropics-docx"] } },
      roleCard: { name: "冷静的审阅者", description: "审阅文书", personality: "克制、精确", scenario: "法务部" },
    });
    assert.equal(result.ok, true);
    assert.ok(result.roleCharacterId);
    const character = characterRepository.getCharacter(OWNER, result.roleCharacterId);
    assert.ok(character);
    const card = characterRepository.getRevision(OWNER, character.currentRevisionId);
    assert.equal(card.source.kind, "agent_draft");
    assert.equal(card.canonical.name, "冷静的审阅者");
    assert.equal(agentRepository.getRevision(OWNER, result.revisionId).definition.role.characterEntityId, result.roleCharacterId);
  });

  await check("revise is CAS-guarded and validation failures name the field with a repair hint", async () => {
    const stale = await call({ action: "revise", agentId: created.agentId, expectedBaseRevisionId: "not-current", definition: { name: "x" } });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "AGENT_REVISION_CONFLICT");
    assert.equal(stale.currentRevisionId, created.revisionId);
    const bad = await call({ action: "revise", agentId: created.agentId, expectedBaseRevisionId: created.revisionId, definition: { name: "x", autonomy: { permissionModeId: "yolo" } } });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "AGENT_DEFINITION_INVALID");
    assert.equal(bad.field, "autonomy.permissionModeId");
    assert.match(bad.repairHint, /autonomy\.permissionModeId/);
    const revised = await call({ action: "revise", agentId: created.agentId, expectedBaseRevisionId: created.revisionId, definition: { name: "审合同的小助手 v2", role: { officialCharacterId: "lily-contract-reviewer" } } });
    assert.equal(revised.ok, true);
    assert.equal(revised.revisionNumber, 2);
  });

  await check("malformed args, missing owner, and kill switch fail closed with stable codes", async () => {
    assert.equal((await call({ action: "delete", definition: { name: "x" } })).error, "INVALID_INPUT");
    assert.equal((await call({ action: "create" })).error, "INVALID_INPUT");
    assert.equal((await call({ action: "revise", definition: { name: "x" } })).error, "INVALID_INPUT");
    const noOwner = await tool.handler({ action: "create", definition: { name: "x" } }, { platformOnly: true }, { ...deps, resolveOwnerScope: async () => "" });
    assert.equal(noOwner.error, "IMPORT_OWNER_UNAVAILABLE");
    process.env.LILY_AGENTS = "0";
    assert.equal((await call({ action: "create", definition: { name: "x" } })).error, "AGENTS_UNAVAILABLE");
    delete process.env.LILY_AGENTS;
    const bare = buildAgentDraftTool({ log: () => {} });
    const noRepo = await bare.handler({ action: "create", definition: { name: "x" } }, PLATFORM, { resolveOwnerScope: async () => OWNER });
    assert.equal(noRepo.error, "AGENTS_UNAVAILABLE");
    const brokenRepo = await bare.handler({ action: "create", definition: { name: "x" } }, PLATFORM, { resolveAgentRepository: () => { throw new Error("boom"); } });
    assert.equal(brokenRepo.error, "AGENTS_UNAVAILABLE", "a repository construction failure fails closed");
  });

  await check("roleCard requires the Character Worlds policy; without it the hint points to an official role", async () => {
    const denied = await call({ action: "create", definition: { name: "x" }, roleCard: { name: "r" } }, { ...PLATFORM, characterWorlds: { enabled: false } });
    assert.equal(denied.error, "CHARACTER_WORLDS_UNAVAILABLE");
    assert.match(denied.repairHint, /officialCharacterId/);
    const before = agentRepository.listAgents(OWNER).length;
    const invalidCard = await call({ action: "create", definition: { name: "x" }, roleCard: { name: "" } });
    assert.equal(invalidCard.ok, false);
    assert.equal(agentRepository.listAgents(OWNER).length, before, "a rejected role card writes no agent");
  });

  console.log(`\n${checks} checks passed (agent draft tool)`);
} finally {
  delete process.env.LILY_AGENTS;
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
