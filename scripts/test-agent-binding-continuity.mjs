#!/usr/bin/env node
// Agent binding closes its loop (2026-09-15 user report: "I only see the
// surface"): every binding change leaves a durable in-conversation record;
// activating an agent (or toggling skills) no longer resets the engine
// session's context; an explicit role choice made under an agent releases
// the agent first and says so; and each assistant record names the agent
// that answered. [gate: agent-management]
// Run: node scripts/test-agent-binding-continuity.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { activateAgent } = require("../src/main/agents/agent-activation.js");
const { resolveSessionAgentPolicy, agentLabelFor, invalidateSessionAgentPolicy } = require("../src/main/agents/session-agent-policy.js");
const { commitAgentBindingNotice, summarizeBinding } = require("../src/main/agents/agent-binding-notice.js");
const { keepEngineAcrossSkillChange } = require("../src/main/engine-skill-continuity.js");
const { releaseAgentForRoleChange } = require("../src/main/agents/role-binding-with-agent.js");
const { buildResumeBinding, verifyResumeBinding, skillSetHash } = require("../src/main/resume-binding.js");
const { TurnArchive } = require("../src/main/turn-archive.js");

const OWNER = "profile:account:continuity-owner";
const SESSION = "session-continuity";
let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-binding-continuity-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const agentRepo = store.agents();
const characterRepo = store.characterWorlds();
const session = { id: SESSION, projectId: "p1", enabledSkillIds: ["lily-global-a"], agentResumeId: "ses_engine_1", agentResumeBinding: null };
const messages = new Map();
const events = [];
const sessionManager = {
  findById: (id) => (id === SESSION ? session : null),
  resolveTurnOwnerScope: (id) => (id === SESSION ? { ok: true, ownerScope: OWNER } : { ok: false, error: "NO_SESSION" }),
  setEnabledSkillIds(_id, ids) { if (ids == null) session.enabledSkillIds = ["lily-global-a"]; else session.enabledSkillIds = [...ids]; return true; },
  setPermissionMode() { return true; },
  setAgentBinding() { return true; },
  claimAgentResumeId(_id, resumeId, binding) { session.agentResumeId = resumeId; if (binding) session.agentResumeBinding = { ...binding }; return { ok: true, evictedSessionIds: [] }; },
  findMessage: (_s, id) => messages.get(id) || null,
  pushMessageTo: (_s, role, content, _files, extra) => { messages.set(extra.id, { id: extra.id, role, content, turnId: extra.turnId, meta: extra.meta }); },
  _store: () => store,
};
const installed = new Set(["lily-global-a", "lily-document-query", "lily-research-synthesis"]);
const skillManager = {
  getAllInstalledSkillIds: () => [...installed],
  installFromRegistry: async () => ({ ok: false, error: "NOT_IN_REGISTRY" }),
  resolveSessionSkillIds: (s) => (Array.isArray(s?.enabledSkillIds) ? [...s.enabledSkillIds] : ["lily-global-a"]),
  normalizeSessionSkillSelection: (ids) => [...new Set(ids)].filter((id) => installed.has(id)),
  writeSessionAgentGuide: () => "",
};
const runner = { alive: true, busy: false, terminated: 0, isAlive() { return this.alive; }, isBusy() { return this.busy; }, reloadSkills() { return false; } };
const ctx = {
  sessionManager, agentRepository: agentRepo, characterWorldsRepository: characterRepo,
  projectManager: { find: () => ({ id: "p1", path: tmp }) },
  runnerPool: { get: () => runner, terminateSession: () => { runner.terminated += 1; runner.alive = false; } },
  eventBus: { emit: (sid, event) => events.push({ sid, ...event }) },
};
const deps = { skillManager, modelSelection: { listModelSelectionPublic: () => ({ models: [] }), setModelSelectionPreference: () => ({ ok: true }), getSessionModelSelection: () => null, clearSessionModelSelection: () => true },
  characterPolicyEnabled: () => false, countServeProfiles: () => 0, locale: () => "zh-CN", log: () => {} };
// The activation path reads deps from ctx in production; mirror the test fixture by pre-binding them.
const realDefaultDeps = require("../src/main/agents/agent-activation.js");
const Module = require("node:module");
const skillManagerPath = require.resolve("../src/main/skill-manager.js");
Module._cache[skillManagerPath] = { id: skillManagerPath, filename: skillManagerPath, loaded: true, exports: skillManager };

try {
  const revision = agentRepo.createAgent({ ownerScope: OWNER, definition: {
    name: "深度研究员", icon: "🔬", description: "研究", role: null,
    skills: { required: ["lily-research-synthesis"], enabled: ["lily-document-query"] },
    knowledge: { packs: [], guidance: "先列检索计划" }, autonomy: { permissionModeId: "ask" },
  }, source: { kind: "created" } }).revision;

  await check("the binding notice is a durable platform record with the agent's contents, idempotent per binding version", async () => {
    const result = await activateAgent({ ctx, sessionId: SESSION, agentRevisionId: revision.id, deps });
    const first = commitAgentBindingNotice(ctx, SESSION, { kind: "activated", agent: { id: revision.agentId, name: "深度研究员", icon: "🔬" }, definition: revision.definition, receipt: result.receipt, bindingVersion: result.binding.bindingVersion, locale: "zh-CN" });
    assert.equal(first.ok, true);
    assert.match(first.message.content, /已切换到智能体「深度研究员」/);
    assert.match(first.message.content, /技能：lily-research-synthesis、lily-document-query/);
    assert.match(first.message.content, /执行模式：确认后执行/);
    assert.match(first.message.content, /上下文会继续保留/);
    assert.equal(first.message.meta.agentBinding.kind, "activated");
    assert.deepEqual(first.message.meta.agentBinding.skills, ["lily-research-synthesis", "lily-document-query"]);
    assert.equal(first.message.meta.agentBinding.keepsEngine, true);
    assert.notEqual(first.message.turnId, SESSION);
    const again = commitAgentBindingNotice(ctx, SESSION, { kind: "activated", agent: { id: revision.agentId, name: "深度研究员" }, definition: revision.definition, receipt: result.receipt, bindingVersion: result.binding.bindingVersion });
    assert.equal(messages.size, 1, "idempotent");
    assert.equal(again.message.id, first.message.id);
    const event = events.find((e) => e.type === "engine.notice" && e.source === "agent_binding");
    assert.equal(event.payload.notice.code, "agentBindingChanged");
    assert.equal(event.payload.committedMessage.id, first.message.id);
    const en = summarizeBinding(revision.definition, result.receipt);
    assert.equal(en.autonomy, "ask");
    assert.equal(commitAgentBindingNotice(ctx, SESSION, { kind: "bogus", agent: { name: "x" }, bindingVersion: 9 }).skipped, "not_applicable");
    process.env.LILY_AGENT_BINDING_NOTICE = "0";
    assert.equal(commitAgentBindingNotice(ctx, SESSION, { kind: "deactivated", agent: { name: "x" }, bindingVersion: 9 }).skipped, "disabled");
    delete process.env.LILY_AGENT_BINDING_NOTICE;
  });

  await check("a deliberate skill change re-pins the engine resume binding so the next spawn RESUMES instead of starting fresh", async () => {
    // Engine session was bound while the session ran only the global skill.
    session.agentResumeBinding = buildResumeBinding({ session, project: { id: "p1", path: tmp }, activeSkillIds: ["lily-global-a"], sessionManager: { getFirstUserMessage: () => null }, resumeId: session.agentResumeId });
    // The agent activation above changed the skill set → the stored hash is stale.
    const expected = buildResumeBinding({ session, project: { id: "p1", path: tmp }, activeSkillIds: skillManager.resolveSessionSkillIds(session), sessionManager: { getFirstUserMessage: () => null }, resumeId: session.agentResumeId });
    assert.equal(verifyResumeBinding(session, expected).ok, false, "without the fix the mismatch forces a fresh engine session");
    const kept = keepEngineAcrossSkillChange(ctx, SESSION);
    assert.deepEqual([kept.ok, kept.kept, kept.reason], [true, true, "rebound"]);
    assert.equal(session.agentResumeBinding.enabledSkillIdsHash, skillSetHash(skillManager.resolveSessionSkillIds(session)));
    assert.equal(verifyResumeBinding(session, expected).ok, true, "the resumed engine keeps the conversation");
    assert.equal(keepEngineAcrossSkillChange(ctx, SESSION).reason, "unchanged");
    process.env.LILY_KEEP_ENGINE_ON_SKILL_CHANGE = "0";
    assert.equal(keepEngineAcrossSkillChange(ctx, SESSION).reason, "disabled");
    delete process.env.LILY_KEEP_ENGINE_ON_SKILL_CHANGE;
    assert.equal(keepEngineAcrossSkillChange(ctx, "missing").reason, "no_resume_binding");
  });

  await check("each assistant record names the agent that answered; none when native", async () => {
    const label = agentLabelFor(ctx, SESSION);
    assert.deepEqual(label, { id: revision.agentId, name: "深度研究员", icon: "🔬" });
    const archive = new TurnArchive(sessionManager);
    const base = { turnId: "t1", tools: new Map(), timeline: [], notices: [], contentBlocks: [], processEvents: [], assistantText: "done" };
    const record = archive.buildRecord({ ...base, agentLabel: label }, "turn.completed", { assistant: "done" });
    assert.deepEqual(record.meta.agent, label);
    assert.equal(archive.buildRecord({ ...base, agentLabel: null }, "turn.completed", { assistant: "done" }).meta.agent, undefined);
    const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
    assert.equal((orchestrator.match(/state\.agentLabel = require\("\.\/agents\/session-agent-policy"\)\.agentLabelFor\(this\.ctx, session\.id\)/g) || []).length, 2, "both turn-state inits stamp the label");
  });

  await check("an explicit role choice under an agent releases the agent, restores its snapshot, records why, and reports it to the caller", async () => {
    assert.equal(resolveSessionAgentPolicy(ctx, SESSION).active, true);
    const before = messages.size;
    const released = await releaseAgentForRoleChange(ctx, SESSION, { roleName: "苏格拉底", locale: "zh-CN" });
    assert.equal(released.name, "深度研究员");
    assert.equal(released.agentId, revision.agentId);
    invalidateSessionAgentPolicy(SESSION);
    assert.equal(resolveSessionAgentPolicy(ctx, SESSION).active, false, "agent released");
    assert.deepEqual(session.enabledSkillIds, ["lily-global-a"], "pre-activation skills restored");
    assert.equal(messages.size, before + 1);
    const record = [...messages.values()].pop();
    assert.match(record.content, /已改选角色「苏格拉底」，智能体「深度研究员」随之停用/);
    assert.equal(record.meta.agentBinding.kind, "replaced_by_role");
    assert.equal(record.meta.agentBinding.roleName, "苏格拉底");
    assert.ok(runner.terminated >= 1, "idle runner recycled so the restored settings apply next prompt");
    assert.equal(await releaseAgentForRoleChange(ctx, SESSION, { roleName: "x" }), null, "no agent → nothing to release");
    assert.equal(agentLabelFor(ctx, SESSION), null);
  });

  await check("wiring: IPC handlers commit notices, keep the engine on manual skill toggles, and release the agent on role change", async () => {
    const agents = fs.readFileSync(new URL("../src/main/ipc-agents.js", import.meta.url), "utf8");
    assert.match(agents, /noteBinding\(resolved, payload\.sessionId, "activated"/);
    assert.match(agents, /noteBinding\(resolved, payload\.sessionId, "deactivated"/);
    assert.match(agents, /require\("\.\/agents\/session-runtime-refresh"\)\.refreshSessionRuntime\(ctx, sessionId\)/);
    const sessions = fs.readFileSync(new URL("../src/main/ipc-sessions.js", import.meta.url), "utf8");
    assert.match(sessions, /keepEngineAcrossSkillChange\(ctx, sessionId\)/);
    const characters = fs.readFileSync(new URL("../src/main/ipc-character-worlds.js", import.meta.url), "utf8");
    assert.match(characters, /releaseAgentForRoleChange\(ctx, session\.sessionId, \{ roleName \}\)/);
    assert.match(characters, /agentDeactivated: released/);
    const refresh = fs.readFileSync(new URL("../src/main/agents/session-runtime-refresh.js", import.meta.url), "utf8");
    assert.ok(refresh.indexOf("keepEngineAcrossSkillChange") < refresh.indexOf("terminateSession"), "binding is re-pinned before the runner is recycled");
  });

  console.log(`\n${checks} checks passed (agent binding continuity)`);
} finally {
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
