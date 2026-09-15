#!/usr/bin/env node
// 智能体 activation: every dimension is applied through the EXISTING setters
// and fails open independently; cold dimensions respect the serve fork
// budget; the pre-activation snapshot restores exactly on deactivate; the
// role card binds through the character repository (official install on
// first use) and never through prompt text. [gate: agent-management]
// Run: node scripts/test-agent-activation.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { activateAgent, deactivateAgent, coldBudgetAvailable } = require("../src/main/agents/agent-activation.js");
const { resolveSessionAgentPolicy, invalidateSessionAgentPolicy } = require("../src/main/agents/session-agent-policy.js");
const { getOfficialAgent } = require("../src/main/agents/official-agent-catalog.js");

const OWNER = "profile:account:activation-owner";
const SESSION = "session-activation";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activation-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const agentRepo = store.agents();
const characterRepo = store.characterWorlds();

// --- fakes for the existing setters -----------------------------------------
const sessions = new Map([[SESSION, { id: SESSION, projectId: "project-1", enabledSkillIds: undefined, permissionModeId: undefined }]]);
const calls = [];
const sessionManager = {
  findById: (id) => sessions.get(id) || null,
  resolveTurnOwnerScope: (id) => (sessions.has(id) ? { ok: true, ownerScope: OWNER } : { ok: false, error: "NO_SESSION" }),
  setEnabledSkillIds(id, ids) {
    calls.push(["skills", ids]);
    const session = sessions.get(id);
    if (ids == null) delete session.enabledSkillIds; else session.enabledSkillIds = [...ids];
    return true;
  },
  setPermissionMode(id, mode) {
    calls.push(["permission", mode]);
    const session = sessions.get(id);
    if (mode == null) delete session.permissionModeId; else session.permissionModeId = mode;
    return true;
  },
  setAgentBinding(id, mirror) { calls.push(["mirror", mirror]); sessions.get(id).agentBinding = mirror || undefined; return true; },
  _store: () => store,
};
const installed = new Set(["lily-document-query", "lily-research-synthesis", "anthropics-docx", "lily-global-a"]);
const skillManager = {
  getAllInstalledSkillIds: () => [...installed],
  installFromRegistry: async (id) => {
    calls.push(["install", id]);
    if (id === "lily-installable") { installed.add(id); return { ok: true }; }
    return { ok: false, error: "NOT_IN_REGISTRY" };
  },
  resolveSessionSkillIds: (session) => (Array.isArray(session?.enabledSkillIds) ? [...session.enabledSkillIds] : ["lily-global-a"]),
  normalizeSessionSkillSelection: (ids) => [...new Set(ids)].filter((id) => installed.has(id) || id === "lily-global-a"),
};
const modelStore = new Map();
const modelSelection = {
  listModelSelectionPublic: () => ({ models: [{ id: "deepseek-v4" }, { id: "qwen-max" }] }),
  setModelSelectionPreference: (selection, sessionId) => { calls.push(["model", selection.manualModelId]); modelStore.set(sessionId, selection); return { ok: true }; },
  getSessionModelSelection: (sessionId) => modelStore.get(sessionId) || null,
  clearSessionModelSelection: (sessionId) => { calls.push(["model-clear"]); return modelStore.delete(sessionId); },
};
const tasks = [];
const scheduledTaskManager = {
  importPausedTemplates: (templates, scope) => {
    const created = templates.map((template, index) => ({ id: `sched_${tasks.length + index}`, ...template, ...scope, enabled: false }));
    tasks.push(...created);
    return { ok: true, tasks: created, skipped: 0 };
  },
  remove: (taskId) => { calls.push(["task-remove", taskId]); const idx = tasks.findIndex((task) => task.id === taskId); if (idx >= 0) tasks.splice(idx, 1); return { ok: idx >= 0 }; },
};
let policyEnabled = true;
let profileCount = 0;
const ctx = { sessionManager, agentRepository: agentRepo, characterWorldsRepository: characterRepo, scheduledTaskManager, projectManager: { find: () => ({ path: tmp }) } };
const deps = {
  skillManager,
  modelSelection,
  scheduledTaskManager,
  characterPolicyEnabled: () => policyEnabled,
  countServeProfiles: () => profileCount,
  locale: () => "zh-CN",
  log: () => {},
};

function seed(definition, source = { kind: "created" }) {
  return agentRepo.createAgent({ ownerScope: OWNER, definition, source }).revision;
}

try {
  await check("kill switch refuses activation with a stable code and touches nothing", async () => {
    process.env.LILY_AGENTS = "0";
    const revision = seed({ name: "开关测试" });
    await assert.rejects(activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps }), (err) => err.code === "AGENTS_UNAVAILABLE");
    assert.equal(resolveSessionAgentPolicy(ctx, SESSION).active, false);
    delete process.env.LILY_AGENTS;
    assert.equal(calls.length, 0);
  });

  await check("official legal counsel activates every hot dimension through existing setters", async () => {
    const official = getOfficialAgent("lily-agent-cn-legal-counsel", "zh-CN");
    const revision = agentRepo.createAgent({ ownerScope: OWNER, definition: official.definition, source: official.source, officialId: official.id }).revision;
    const result = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    assert.equal(result.ok, true);
    assert.equal(result.binding.bindingVersion, 1);
    // role → character repository binding (official character installed on first use)
    assert.equal(result.receipt.role.status, "applied");
    assert.equal(result.receipt.role.installed, true);
    const characterBinding = characterRepo.getBinding(SESSION, OWNER);
    assert.equal(characterBinding.mode, "character");
    assert.equal(characterBinding.characterRevisionId, result.receipt.role.characterRevisionId);
    const card = characterRepo.getRevision(OWNER, characterBinding.characterRevisionId);
    assert.equal(card.source.officialId, "lily-cn-legal-counsel");
    // skills → union of what the session already had + the agent's, required present
    assert.equal(result.receipt.skills.status, "applied");
    assert.ok(result.receipt.skills.enabled.includes("lily-document-query"));
    assert.ok(result.receipt.skills.enabled.includes("lily-global-a"), "agent skills ADD to existing ones");
    assert.deepEqual(sessions.get(SESSION).enabledSkillIds, result.receipt.skills.enabled);
    // autonomy → session permission mode
    assert.equal(result.receipt.autonomy.status, "applied");
    assert.equal(sessions.get(SESSION).permissionModeId, "ask");
    // knowledge → validated, prepared lazily at first turn
    assert.equal(result.receipt.knowledge.status, "applied");
    assert.deepEqual(result.receipt.knowledge.packs, ["legal-cn-enterprise"]);
    assert.equal(result.receipt.knowledge.preparedAt, "first_turn");
    // tools → advisory mcpAllow recorded, no cold disallow
    assert.equal(result.receipt.tools.status, "applied");
    assert.deepEqual(result.receipt.tools.mcpAllow, ["lily_legal_search"]);
    assert.equal(result.receipt.tools.cold, false);
    assert.equal(result.receipt.model.status, "skipped");
    assert.equal(result.receipt.coldApplied, false);
    assert.deepEqual(result.receipt.degraded, []);
    // previous snapshot captured BEFORE mutation
    const stored = agentRepo.getBinding(SESSION, OWNER);
    assert.equal(stored.previous.enabledSkillIds, null);
    assert.equal(stored.previous.permissionModeId, null);
    assert.equal(stored.previous.character.mode, "native");
    // mirror + policy
    assert.equal(sessions.get(SESSION).agentBinding.name, official.definition.name);
    const policy = resolveSessionAgentPolicy(ctx, SESSION);
    assert.equal(policy.active, true);
    assert.deepEqual([...policy.knowledgePacks], ["legal-cn-enterprise"]);
    assert.deepEqual([...policy.disallowedTools], []);
  });

  await check("re-activating the same official role is idempotent for the character binding", async () => {
    const current = agentRepo.getBinding(SESSION, OWNER);
    const result = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: current.agentRevisionId, expectedBindingVersion: current.bindingVersion, deps });
    assert.equal(result.receipt.role.unchanged, true);
    assert.equal(result.receipt.role.installed, undefined);
    // the ORIGINAL pre-activation snapshot is preserved across re-activation
    assert.equal(agentRepo.getBinding(SESSION, OWNER).previous.character.mode, "native");
  });

  await check("stale binding version is a coded conflict", async () => {
    const current = agentRepo.getBinding(SESSION, OWNER);
    await assert.rejects(
      activateAgent({ ctx, sessionId: SESSION, agentRevisionId: current.agentRevisionId, expectedBindingVersion: current.bindingVersion + 5, deps }),
      (err) => err.code === "AGENT_BINDING_CONFLICT",
    );
  });

  await check("deactivate restores the exact pre-activation state (native role, inherited skills/permission)", async () => {
    const current = agentRepo.getBinding(SESSION, OWNER);
    const result = await deactivateAgent({ ctx, sessionId: SESSION, expectedBindingVersion: current.bindingVersion, deps });
    assert.equal(result.ok, true);
    assert.deepEqual(result.restored, { skills: true, autonomy: true, model: true, role: true, automations: true });
    assert.equal(sessions.get(SESSION).enabledSkillIds, undefined);
    assert.equal(sessions.get(SESSION).permissionModeId, undefined);
    assert.equal(characterRepo.getBinding(SESSION, OWNER).mode, "native");
    assert.equal(agentRepo.getBinding(SESSION, OWNER).agentRevisionId, null);
    assert.equal(sessions.get(SESSION).agentBinding, undefined);
    assert.equal(resolveSessionAgentPolicy(ctx, SESSION).active, false);
  });

  await check("each dimension fails open independently and the receipt names the reason", async () => {
    policyEnabled = false;
    const revision = seed({
      name: "降级测试",
      role: { officialCharacterId: "lily-researcher" },
      skills: { required: ["lily-not-installed", "lily-installable"], enabled: ["lily-research-synthesis"] },
      knowledge: { packs: ["legal-cn-enterprise", "nonexistent-pack"] },
      model: { presetId: "model-that-does-not-exist" },
      autonomy: { permissionModeId: "plan" },
    });
    const result = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    assert.equal(result.receipt.role.status, "degraded");
    assert.equal(result.receipt.role.reason, "character_policy_disabled");
    assert.equal(characterRepo.getBinding(SESSION, OWNER).mode, "native", "role never bound when policy is off");
    assert.equal(result.receipt.skills.status, "degraded");
    assert.equal(result.receipt.skills.reason, "required_skills_missing");
    assert.deepEqual(result.receipt.skills.missing, ["lily-not-installed"]);
    assert.deepEqual(result.receipt.skills.installedNow, ["lily-installable"]);
    assert.ok(result.receipt.skills.enabled.includes("lily-installable"), "installable required skill was installed and enabled");
    assert.equal(result.receipt.knowledge.status, "degraded");
    assert.deepEqual(result.receipt.knowledge.unknown, ["nonexistent-pack"]);
    assert.deepEqual(result.receipt.knowledge.packs, ["legal-cn-enterprise"]);
    assert.equal(result.receipt.model.status, "degraded");
    assert.equal(result.receipt.model.reason, "model_unavailable");
    assert.equal(modelStore.has(SESSION), false, "no model override written for an unknown model");
    assert.equal(result.receipt.autonomy.status, "applied");
    assert.equal(sessions.get(SESSION).permissionModeId, "plan");
    assert.deepEqual(result.receipt.degraded.map((item) => item.dimension), ["role", "skills", "knowledge", "model"]);
    // the binding still exists — a degraded agent is still an agent
    assert.equal(agentRepo.getBinding(SESSION, OWNER).agentRevisionId, revision.id);
    await deactivateAgent({ ctx, sessionId: SESSION, deps });
    policyEnabled = true;
  });

  await check("cold dimensions apply within the serve fork budget and degrade beyond it", async () => {
    const revision = seed({ name: "冷维度", model: { presetId: "deepseek-v4" }, tools: { disallow: ["lily_tool_broker_lily_legal_search"], mcpAllow: ["lily_fi_query"] } });
    profileCount = 0;
    const within = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    assert.equal(within.receipt.model.status, "applied");
    assert.equal(within.receipt.model.cold, true);
    assert.equal(modelStore.get(SESSION).manualModelId, "deepseek-v4");
    assert.deepEqual(within.receipt.tools.disallow, ["lily_tool_broker_lily_legal_search"]);
    assert.equal(within.receipt.coldApplied, true);
    assert.deepEqual([...resolveSessionAgentPolicy(ctx, SESSION).disallowedTools], ["lily_tool_broker_lily_legal_search"]);
    await deactivateAgent({ ctx, sessionId: SESSION, deps });
    assert.equal(modelStore.has(SESSION), false, "deactivate cleared the model override");

    profileCount = 3;
    assert.deepEqual(coldBudgetAvailable({ countServeProfiles: () => 3 }), { ok: false, count: 3, limit: 3 });
    const beyond = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    assert.equal(beyond.receipt.model.status, "degraded");
    assert.equal(beyond.receipt.model.reason, "serve_fork_budget");
    assert.equal(beyond.receipt.tools.status, "degraded");
    assert.deepEqual(beyond.receipt.tools.disallow, []);
    assert.deepEqual(beyond.receipt.tools.mcpAllow, ["lily_fi_query"], "advisory preferences survive the budget");
    assert.equal(beyond.receipt.coldApplied, false);
    assert.deepEqual([...resolveSessionAgentPolicy(ctx, SESSION).disallowedTools], ["lily_tool_broker_lily_legal_search"],
      "policy reads the DEFINITION; the runner applies it only when the serve is rebuilt within budget — see ipc-utils");
    await deactivateAgent({ ctx, sessionId: SESSION, deps });
    profileCount = 0;
  });

  await check("automations import paused and are removed on deactivate", async () => {
    const revision = seed({ name: "定时", automations: [{ title: "巡检", prompt: "检查收件箱", schedule: { type: "daily", hour: 9, minute: 0 } }] });
    const result = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    assert.equal(result.receipt.automations.status, "applied");
    assert.equal(result.receipt.automations.paused, true);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].enabled, false);
    assert.equal(tasks[0].sessionId, SESSION);
    await deactivateAgent({ ctx, sessionId: SESSION, deps });
    assert.equal(tasks.length, 0, "deactivate removed the imported tasks");
  });

  await check("previously customized session values are restored verbatim", async () => {
    sessions.get(SESSION).enabledSkillIds = ["anthropics-docx"];
    sessions.get(SESSION).permissionModeId = "full";
    modelStore.set(SESSION, { mode: "manual", manualModelId: "qwen-max" });
    const revision = seed({ name: "还原", skills: { enabled: ["lily-document-query"] }, autonomy: { permissionModeId: "plan" }, model: { presetId: "deepseek-v4" } });
    await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    assert.deepEqual(sessions.get(SESSION).enabledSkillIds.sort(), ["anthropics-docx", "lily-document-query"]);
    assert.equal(sessions.get(SESSION).permissionModeId, "plan");
    assert.equal(modelStore.get(SESSION).manualModelId, "deepseek-v4");
    await deactivateAgent({ ctx, sessionId: SESSION, deps });
    assert.deepEqual(sessions.get(SESSION).enabledSkillIds, ["anthropics-docx"]);
    assert.equal(sessions.get(SESSION).permissionModeId, "full");
    assert.equal(modelStore.get(SESSION).manualModelId, "qwen-max");
  });

  await check("policy is fail-open: unknown session, missing repository, kill switch all read inactive", async () => {
    assert.equal(resolveSessionAgentPolicy(ctx, "nope").active, false);
    assert.equal(resolveSessionAgentPolicy({}, SESSION).active, false);
    assert.equal(resolveSessionAgentPolicy(null, SESSION).active, false);
    process.env.LILY_AGENTS = "0";
    invalidateSessionAgentPolicy(SESSION);
    assert.equal(resolveSessionAgentPolicy(ctx, SESSION).active, false);
    delete process.env.LILY_AGENTS;
  });

  console.log(`\n${checks} checks passed (agent activation)`);
} finally {
  delete process.env.LILY_AGENTS;
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
