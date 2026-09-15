#!/usr/bin/env node
// Knowledge packs + turn preparation: the legal role's hard-coded pack rule
// is preserved verbatim, an agent's knowledge.packs join it, unknown packs
// are reported by name, a failing pack blocks the turn with a coded error,
// and no bound agent + no legal role means no preparation at all.
// Run: node scripts/test-agent-knowledge-preparation.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { ensureKnowledgePacks, getKnowledgePack, knowledgePackLabel, listKnowledgePacks } = require("../src/main/agents/knowledge-packs.js");
const { prepareLegalKnowledgeForTurn, LEGAL_PACK_ID } = require("../src/main/legal-kb/turn-preparation.js");
const { invalidateSessionAgentPolicy } = require("../src/main/agents/session-agent-policy.js");

const OWNER = "profile:account:kb-owner";
const SESSION = "session-kb";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const agentRepo = store.agents();
const characterRepo = store.characterWorlds();
const ensured = [];
let failNext = false;
const manager = {
  ensureLegalKnowledgePack: async () => {
    ensured.push(LEGAL_PACK_ID);
    return failNext ? { ok: false, error: "LEGAL_KB_DOWNLOAD_FAILED" } : { ok: true, version: "2026.09", path: "/tmp/legal" };
  },
};
const sessionManager = {
  findById: (id) => (id === SESSION ? { id: SESSION, projectId: "p" } : null),
  resolveTurnOwnerScope: (id) => (id === SESSION ? { ok: true, ownerScope: OWNER } : { ok: false, error: "NO_SESSION" }),
  _store: () => store,
};
const ctx = { sessionManager, agentRepository: agentRepo, characterWorldsRepository: characterRepo, legalKnowledgeManager: manager };
const log = { warn: () => {} };
const session = { id: SESSION };

try {
  await check("registry knows the legal pack and labels it per locale", async () => {
    assert.deepEqual(listKnowledgePacks().map((pack) => pack.id), [LEGAL_PACK_ID]);
    assert.deepEqual([...getKnowledgePack(LEGAL_PACK_ID).tools], ["lily_legal_search"]);
    assert.equal(knowledgePackLabel(LEGAL_PACK_ID, "zh-CN"), "中国企业法律知识库");
    assert.equal(knowledgePackLabel("unknown-pack", "zh-CN"), "unknown-pack");
    assert.equal(getKnowledgePack("Nope"), null);
  });

  await check("ensureKnowledgePacks reports per pack and names the first failure", async () => {
    const ok = await ensureKnowledgePacks([LEGAL_PACK_ID], { manager });
    assert.equal(ok.ready, true);
    assert.equal(ok.packs[0].version, "2026.09");
    const unknown = await ensureKnowledgePacks(["mystery"], { manager });
    assert.equal(unknown.ready, false);
    assert.equal(unknown.error, "KNOWLEDGE_PACK_UNKNOWN");
    assert.equal(unknown.failedPackId, "mystery");
    failNext = true;
    const failed = await ensureKnowledgePacks([LEGAL_PACK_ID], { manager });
    failNext = false;
    assert.equal(failed.ready, false);
    assert.equal(failed.error, "LEGAL_KB_DOWNLOAD_FAILED");
    assert.equal(failed.failedPackId, LEGAL_PACK_ID);
    assert.equal((await ensureKnowledgePacks([], { manager })).required, false);
  });

  await check("no role, no agent → nothing is prepared", async () => {
    ensured.length = 0;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.deepEqual(result, { required: false, ready: true, packs: [] });
    assert.equal(ensured.length, 0);
  });

  await check("legacy rule: the official legal counsel ROLE still requires the legal pack", async () => {
    const official = require("../src/main/character-worlds/official-character-catalog.js").getOfficialCharacter("lily-cn-legal-counsel", "zh-CN");
    const { officialSource } = require("../src/main/official-character-ipc.js");
    const created = characterRepo.createCharacter({ ownerScope: OWNER, canonical: official.canonical, source: officialSource(official) });
    const state = { characterWorldsSnapshot: { snapshotStatus: "ready", mode: "character", characterRevisionId: created.revision.id } };
    ensured.length = 0;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state, options: {}, log });
    assert.equal(result.required, true);
    assert.equal(result.ready, true);
    assert.deepEqual(result.packs.map((pack) => pack.packId), [LEGAL_PACK_ID]);
    assert.deepEqual(ensured, [LEGAL_PACK_ID]);
  });

  await check("a bound agent's knowledge.packs are prepared; an unknown pack blocks with its id", async () => {
    const good = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "法务", knowledge: { packs: [LEGAL_PACK_ID] } }, source: { kind: "created" } }).revision;
    agentRepo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: good.id });
    invalidateSessionAgentPolicy(SESSION);
    ensured.length = 0;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.equal(result.required, true);
    assert.equal(result.ready, true);
    assert.deepEqual(ensured, [LEGAL_PACK_ID]);

    const odd = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "怪", knowledge: { packs: ["mystery-pack"] } }, source: { kind: "created" } }).revision;
    agentRepo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 1, agentRevisionId: odd.id });
    invalidateSessionAgentPolicy(SESSION);
    const blocked = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.equal(blocked.required, true);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.error, "KNOWLEDGE_PACK_UNKNOWN");
    assert.equal(blocked.failedPackId, "mystery-pack");
  });

  await check("a failing pack blocks the turn with the pack's own error", async () => {
    const legal = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "法务2", knowledge: { packs: [LEGAL_PACK_ID] } }, source: { kind: "created" } }).revision;
    agentRepo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 2, agentRevisionId: legal.id });
    invalidateSessionAgentPolicy(SESSION);
    failNext = true;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    failNext = false;
    assert.equal(result.ready, false);
    assert.equal(result.error, "LEGAL_KB_DOWNLOAD_FAILED");
    assert.equal(result.failedPackId, LEGAL_PACK_ID);
  });

  await check("kill switch removes the agent contribution but keeps the legacy role rule", async () => {
    process.env.LILY_AGENTS = "0";
    invalidateSessionAgentPolicy(SESSION);
    ensured.length = 0;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.equal(result.required, false);
    delete process.env.LILY_AGENTS;
  });

  console.log(`\n${checks} checks passed (agent knowledge preparation)`);
} finally {
  delete process.env.LILY_AGENTS;
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
