#!/usr/bin/env node
// Knowledge packs + turn preparation: the legal role's hard-coded pack rule
// is preserved verbatim, an agent's knowledge.packs join it, unknown packs
// are reported by name, and no bound agent + no legal role means no
// preparation at all. Preparation never holds a turn: a pack installed on this
// machine is ready at once (even when the update check fails), installing runs
// in the background, and a pack that is not ready makes the turn run without
// it — told so — instead of failing it.
// Run: node scripts/test-agent-knowledge-preparation.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { ensureKnowledgePacks, getKnowledgePack, knowledgePackLabel, listKnowledgePacks } = require("../src/main/agents/knowledge-packs.js");
const { prepareLegalKnowledgeForTurn, knowledgeWarmups, knowledgeUnavailable, withKnowledgeAvailability, LEGAL_PACK_ID } = require("../src/main/legal-kb/turn-preparation.js");
const swallowed = require("../src/main/diagnostics/swallowed-failure.js");
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
let installed = true;
const manager = {
  status: () => ({ ok: true, installed }),
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
    assert.deepEqual([...getKnowledgePack(LEGAL_PACK_ID).tools], ["lily_legal_search", "lily_legal_article"]);
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

  await check("legacy rule: the official legal counsel ROLE still requires the legal pack — served remotely, never installed", async () => {
    const official = require("../src/main/character-worlds/official-character-catalog.js").getOfficialCharacter("lily-cn-legal-counsel", "zh-CN");
    const { officialSource } = require("../src/main/official-character-ipc.js");
    const created = characterRepo.createCharacter({ ownerScope: OWNER, canonical: official.canonical, source: officialSource(official) });
    const state = { characterWorldsSnapshot: { snapshotStatus: "ready", mode: "character", characterRevisionId: created.revision.id } };
    ensured.length = 0;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state, options: {}, log });
    assert.equal(result.required, true);
    assert.equal(result.ready, true);
    assert.deepEqual(result.packs, [{ packId: LEGAL_PACK_ID, ready: true, source: "service" }]);
    await knowledgeWarmups();
    assert.deepEqual(ensured, [], "the remote corpus is not installed or indexed on this machine");
  });

  await check("a bound agent's knowledge.packs are prepared; an unknown pack is reported with its id", async () => {
    const good = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "法务", knowledge: { packs: [LEGAL_PACK_ID] } }, source: { kind: "created" } }).revision;
    agentRepo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 0, agentRevisionId: good.id });
    invalidateSessionAgentPolicy(SESSION);
    ensured.length = 0;
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.equal(result.required, true);
    assert.equal(result.ready, true);
    assert.deepEqual(result.packs, [{ packId: LEGAL_PACK_ID, ready: true, source: "service" }]);
    await knowledgeWarmups();
    assert.deepEqual(ensured, [], "no local preparation for the remote legal pack");

    const odd = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "怪", knowledge: { packs: ["mystery-pack"] } }, source: { kind: "created" } }).revision;
    agentRepo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 1, agentRevisionId: odd.id });
    invalidateSessionAgentPolicy(SESSION);
    const blocked = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.equal(blocked.required, true);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.error, "KNOWLEDGE_PACK_UNKNOWN");
    assert.equal(blocked.failedPackId, "mystery-pack");
  });

  await check("a service-backed pack is ready without any local install or update check", async () => {
    const legal = agentRepo.createAgent({ ownerScope: OWNER, definition: { name: "法务2", knowledge: { packs: [LEGAL_PACK_ID] } }, source: { kind: "created" } }).revision;
    agentRepo.setBinding({ sessionId: SESSION, ownerScope: OWNER, expectedBindingVersion: 2, agentRevisionId: legal.id });
    invalidateSessionAgentPolicy(SESSION);
    failNext = true; // a failing server / network answer must not matter
    const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
    assert.equal(result.ready, true, "the remote corpus needs nothing on this machine");
    await knowledgeWarmups();
    failNext = false;
  });

  await check("the legal pack never waits on a local download; the unavailable notice is kept for knowledge that truly cannot be prepared", async () => {
    installed = false;
    failNext = true;
    const warn = console.warn; console.warn = () => {};
    manager.ensureLegalKnowledgePack = async () => { ensured.push(LEGAL_PACK_ID); return { ok: false, error: "LEGAL_KB_DOWNLOAD_FAILED" }; };
    try {
      const result = await prepareLegalKnowledgeForTurn({ ctx, session, state: { characterWorldsSnapshot: null }, options: {}, log });
      assert.equal(result.ready, true, "service-backed: a turn never waits on a local download");
      assert.deepEqual(result.packs, [{ packId: LEGAL_PACK_ID, ready: true, source: "service" }]);
      await knowledgeWarmups();
      assert.deepEqual(ensured, [], "and nothing is installed or indexed in the background");
      assert.equal(knowledgeUnavailable(result), null, "no false 'unavailable' warning when the corpus is remote");

      // The honest-unavailable path is unchanged for knowledge that really cannot be prepared.
      const unavailable = { required: true, ready: false, error: "KNOWLEDGE_PACK_NOT_READY", failedPackId: LEGAL_PACK_ID };
      const notices = [];
      const text = withKnowledgeAvailability({ _emitEngineNotice: (_id, notice) => notices.push(notice) }, SESSION, "用户的问题", { legalKnowledge: unavailable });
      assert.match(text, /NOT available/, "the model is told the knowledge base is unavailable");
      assert.match(text, /用户的问题/, "and still gets the user's question");
      assert.match(notices[0].detail, /本轮已照常回答/, "the user is told the answer ran without it");
      assert.equal(withKnowledgeAvailability({}, SESSION, "q", { legalKnowledge: { required: true, ready: true } }), "q", "a ready pack changes nothing");
    } finally {
      console.warn = warn;
      installed = true;
      failNext = false;
    }
  });

  await check("the orchestrator no longer fails a turn over knowledge", async () => {
    const source = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /knowledgeFailure\(legalKnowledge\)/, "no knowledge-failure finalize path remains");
    assert.match(source, /withKnowledgeAvailability\(this, session\.id, engineText, state\)/, "the turn carries the availability instead");
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
