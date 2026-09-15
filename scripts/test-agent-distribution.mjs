#!/usr/bin/env node
// Distributed 智能体 (client half): registry entries are validated and
// bounded, local role ids from a publisher are dropped, targeting from the
// signed config narrows the list and picks a default, reconcile installs /
// refreshes `distributed` revisions idempotently, the default agent binds to
// a new session fail-open, and every network/config failure leaves the
// library untouched.
// Run: node scripts/test-agent-distribution.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const distribution = require("../src/main/agents/agent-distribution.js");

const OWNER = "profile:account:dist-owner";
let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dist-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const agentRepo = store.agents();
const characterRepo = store.characterWorlds();

const entryRaw = {
  packageId: "pkg-1", agentId: "org-legal", version: "1.0.0", channel: "stable",
  scope: { type: "organization", organizationId: "org-9" }, publisher: "ACME Legal", featured: true,
  definition: { name: "ACME 法务", role: { characterEntityId: "publisher-local-id" }, skills: { enabled: ["lily-document-query"] }, knowledge: { packs: ["legal-cn-enterprise"] } },
  roleCard: { canonical: { name: "ACME 法务角色", description: "d", personality: "p", scenario: "s" } },
};

try {
  await check("registry entries are validated, bounded, and publisher-local role ids are dropped", async () => {
    const entry = distribution.normalizeRegistryEntry(entryRaw);
    assert.equal(entry.agentId, "org-legal");
    assert.equal(entry.definition.role, null, "publisher-local character ids mean nothing here");
    assert.equal(entry.roleCard.canonical.name, "ACME 法务角色");
    assert.equal(entry.scope.type, "organization");
    assert.equal(distribution.normalizeRegistryEntry({ ...entryRaw, definition: { name: "" } }), null);
    assert.equal(distribution.normalizeRegistryEntry({ ...entryRaw, packageId: "" }), null);
    assert.equal(distribution.normalizeRegistryEntry(null), null);
    const official = distribution.normalizeRegistryEntry({ ...entryRaw, definition: { name: "x", role: { officialCharacterId: "lily-researcher" } }, roleCard: undefined });
    assert.deepEqual(official.definition.role, { officialCharacterId: "lily-researcher" });
  });

  await check("targeting: absent block → everything, available narrows, default must be available", async () => {
    const cache = { agents: [distribution.normalizeRegistryEntry(entryRaw), distribution.normalizeRegistryEntry({ ...entryRaw, packageId: "pkg-2", agentId: "org-writer", definition: { name: "写手" } })] };
    const none = distribution.listDistributedAgents({ cache, remoteConfig: { getRemoteEffectiveConfigSync: () => ({}) } });
    assert.deepEqual(none.agents.map((a) => a.agentId), ["org-legal", "org-writer"]);
    assert.equal(none.defaultAgentId, "");
    const narrowed = distribution.listDistributedAgents({ cache, remoteConfig: { getRemoteEffectiveConfigSync: () => ({ agents: { available: ["org-writer"], default: "org-writer" } }) } });
    assert.deepEqual(narrowed.agents.map((a) => a.agentId), ["org-writer"]);
    assert.equal(narrowed.defaultAgentId, "org-writer");
    const badDefault = distribution.listDistributedAgents({ cache, remoteConfig: { getRemoteEffectiveConfigSync: () => ({ agents: { available: ["org-writer"], default: "org-legal" } }) } });
    assert.equal(badDefault.defaultAgentId, "", "a default outside available is dropped");
    const hostile = distribution.listDistributedAgents({ cache, remoteConfig: { getRemoteEffectiveConfigSync: () => ({ agents: "nope" }) } });
    assert.equal(hostile.agents.length, 2);
    assert.equal(distribution.readAgentTargeting({ getRemoteEffectiveConfigSync: () => { throw new Error("x"); } }), null);
    process.env.LILY_AGENTS = "0";
    assert.deepEqual(distribution.listDistributedAgents({ cache }).agents, []);
    delete process.env.LILY_AGENTS;
  });

  await check("fetch is fail-open and never throws; success writes the cache", async () => {
    const deps = {
      serviceClient: { getServiceSettings: () => ({ apiBaseUrl: "https://svc.test" }) },
      remoteConfig: { getRemoteEffectiveConfigSync: () => ({}) },
      accountManager: { accountStatus: () => ({ loggedIn: true }), accessTokenForService: async () => ({ ok: true, accessToken: "tok" }) },
      log: () => {},
    };
    let seen = null;
    const okFetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, agents: [entryRaw, { broken: true }] }) }; };
    process.env.LILY_USER_DATA_DIR_FOR_TESTS = tmp;
    const result = await distribution.fetchAgentRegistry({ ...deps, fetch: okFetch });
    assert.equal(result.ok, true);
    assert.equal(result.agents.length, 1, "malformed entries are dropped, valid ones kept");
    assert.equal(seen.url, "https://svc.test/api/agents/registry?channel=stable");
    assert.equal(seen.init.headers.Authorization, "Bearer tok", "logged-in fetch carries the account token");
    const anonymous = await distribution.fetchAgentRegistry({ ...deps, accountManager: { accountStatus: () => ({ loggedIn: false }) }, fetch: okFetch });
    assert.equal(anonymous.ok, true);
    assert.equal(seen.init.headers.Authorization, undefined);
    assert.equal((await distribution.fetchAgentRegistry({ ...deps, fetch: async () => ({ ok: false, status: 503, text: async () => "" }) })).error, "SERVICE_REQUEST_FAILED");
    assert.equal((await distribution.fetchAgentRegistry({ ...deps, fetch: async () => { throw new Error("offline"); } })).error, "SERVICE_REQUEST_FAILED");
    assert.equal((await distribution.fetchAgentRegistry({ ...deps, fetch: async () => ({ ok: true, status: 200, text: async () => "{\"ok\":false}" }) })).error, "REGISTRY_INVALID");
    assert.equal((await distribution.fetchAgentRegistry({ ...deps, serviceClient: { getServiceSettings: () => ({}) }, fetch: okFetch })).error, "NO_SERVICE_URL");
    process.env.LILY_AGENTS = "0";
    assert.equal((await distribution.fetchAgentRegistry({ ...deps, fetch: okFetch })).error, "AGENTS_UNAVAILABLE");
    delete process.env.LILY_AGENTS;
  });

  let installed;
  await check("reconcile installs distributed revisions once and refreshes on version change", async () => {
    const entry = distribution.normalizeRegistryEntry(entryRaw);
    installed = distribution.reconcileDistributedAgents(agentRepo, characterRepo, OWNER, [entry]);
    const agentId = installed.get("org-legal");
    assert.ok(agentId);
    const revision = agentRepo.getCurrentRevision(OWNER, agentId);
    assert.equal(revision.source.kind, "distributed");
    assert.equal(revision.source.packageId, "pkg-1");
    assert.equal(revision.source.packageVersion, "1.0.0");
    assert.ok(revision.definition.role.characterEntityId, "embedded role card became a local character");
    assert.equal(characterRepo.getRevision(OWNER, characterRepo.getCharacter(OWNER, revision.definition.role.characterEntityId).currentRevisionId).canonical.name, "ACME 法务角色");
    const again = distribution.reconcileDistributedAgents(agentRepo, characterRepo, OWNER, [entry]);
    assert.equal(again.get("org-legal"), agentId);
    assert.equal(agentRepo.listRevisions(OWNER, agentId).length, 1, "same version → no new revision");
    const v2 = distribution.normalizeRegistryEntry({ ...entryRaw, version: "1.1.0", definition: { ...entryRaw.definition, description: "v2" } });
    distribution.reconcileDistributedAgents(agentRepo, characterRepo, OWNER, [v2]);
    const refreshed = agentRepo.getCurrentRevision(OWNER, agentId);
    assert.equal(refreshed.revisionNumber, 2);
    assert.equal(refreshed.source.packageVersion, "1.1.0");
    assert.equal(refreshed.definition.description, "v2");
    assert.equal(agentRepo.listAgents(OWNER).length, 1, "still one entity");
  });

  await check("default agent binds to a new session fail-open (hot dimensions, no installs)", async () => {
    const session = { id: "new-session", projectId: "p", enabledSkillIds: undefined, permissionModeId: undefined };
    const sessions = new Map([[session.id, session]]);
    const ctx = {
      agentRepository: agentRepo,
      characterWorldsRepository: characterRepo,
      sessionManager: {
        findById: (id) => sessions.get(id) || null,
        resolveTurnOwnerScope: (id) => (sessions.has(id) ? { ok: true, ownerScope: OWNER } : { ok: false, error: "NO_SESSION" }),
        setEnabledSkillIds: (id, ids) => { sessions.get(id).enabledSkillIds = ids; return true; },
        setPermissionMode: () => true,
        setAgentBinding: (id, mirror) => { sessions.get(id).agentBinding = mirror; return true; },
        _store: () => store,
      },
      projectManager: { find: () => ({ path: tmp }) },
    };
    // No default configured → native.
    fs.writeFileSync(path.join(tmp, "agents-registry.json"), JSON.stringify({ schemaVersion: 1, agents: [distribution.normalizeRegistryEntry(entryRaw)] }));
    const none = await distribution.applyDefaultAgentToNewSession(ctx, "new-session");
    assert.equal(none.applied, false);
    assert.equal(agentRepo.getBinding("new-session", OWNER).agentRevisionId, null);
    // With a targeted default: installed on demand, bound with hot dimensions
    // only — required skills are NOT installed on the default path.
    const installCalls = [];
    const entry = distribution.normalizeRegistryEntry(entryRaw);
    const listDistributedAgents = () => ({ agents: [entry], defaultAgentId: "org-legal", fetchedAt: "" });
    const activationDeps = {
      skillManager: {
        getAllInstalledSkillIds: () => ["lily-document-query"],
        installFromRegistry: async (id) => { installCalls.push(id); return { ok: true }; },
        resolveSessionSkillIds: () => [],
        normalizeSessionSkillSelection: (ids) => ids,
      },
      modelSelection: { listModelSelectionPublic: () => ({ models: [] }), setModelSelectionPreference: () => ({ ok: true }), getSessionModelSelection: () => null, clearSessionModelSelection: () => true },
      scheduledTaskManager: null,
      characterPolicyEnabled: () => true,
      countServeProfiles: () => 0,
      locale: () => "zh-CN",
      log: () => {},
    };
    const applied = await distribution.applyDefaultAgentToNewSession(ctx, "new-session", { listDistributedAgents, activationDeps });
    assert.equal(applied.applied, true);
    assert.equal(installCalls.length, 0, "default path never installs skills");
    const binding = agentRepo.getBinding("new-session", OWNER);
    assert.equal(binding.agentId, applied.agentId);
    assert.equal(agentRepo.getCurrentRevision(OWNER, applied.agentId).source.packageId, "pkg-1");
    assert.deepEqual(sessions.get("new-session").enabledSkillIds, ["lily-document-query"]);
    assert.equal(applied.receipt.role.status, "applied", "embedded role card bound through the character repository");
    const unknownSession = await distribution.applyDefaultAgentToNewSession(ctx, "ghost", { listDistributedAgents, activationDeps });
    assert.equal(unknownSession.applied, false);
    const broken = await distribution.applyDefaultAgentToNewSession(ctx, "new-session", { listDistributedAgents: () => { throw new Error("boom"); } });
    assert.equal(broken.applied, false);
    assert.equal(broken.reason, "error");
  });

  console.log(`\n${checks} checks passed (agent distribution)`);
} finally {
  delete process.env.LILY_AGENTS;
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
