#!/usr/bin/env node
// 智能体 authoring routing: "做一个…智能体" routes to lily_agent_draft (winning
// over the role words it contains), engineering uses of "agent" do not, the
// explicit renderer marker kind "agent" is honoured, role/persona/world-book
// routing is unchanged, and availability needs only the local kill switch.
// Run: node scripts/test-agent-routing.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inferCharacterAuthoringIntent, buildCharacterAuthoringEngineText } = require("../src/main/character-worlds/authoring-intent.js");
const { resolveEngineRouting, ensureRoutingAvailable } = require("../src/main/character-worlds/assistant-routing.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

await check("agent intents are detected and beat the role words inside them", async () => {
  assert.deepEqual(inferCharacterAuthoringIntent("帮我做一个审合同的智能体，角色是资深律师"), { active: true, kind: "agent" });
  assert.deepEqual(inferCharacterAuthoringIntent("创建一个数字员工帮我每天巡检邮箱"), { active: true, kind: "agent" });
  assert.deepEqual(inferCharacterAuthoringIntent("Please create an agent that reviews contracts"), { active: true, kind: "agent" });
  assert.deepEqual(inferCharacterAuthoringIntent("设计一个角色卡：冷静的法务顾问"), { active: true, kind: "character" });
  assert.deepEqual(inferCharacterAuthoringIntent("新建一个人设"), { active: true, kind: "persona" });
});

await check("engineering and management uses of 'agent' are not library requests", async () => {
  assert.equal(inferCharacterAuthoringIntent("帮我设计一个智能体管理系统的数据库表").active, false);
  assert.equal(inferCharacterAuthoringIntent("build a multi-agent framework in python").active, false);
  assert.equal(inferCharacterAuthoringIntent("create an agent framework sdk").active, false);
  assert.equal(inferCharacterAuthoringIntent("写一份关于智能体的报告文档").active, false, "document words still win");
  assert.equal(inferCharacterAuthoringIntent("这个智能体怎么用").active, false, "no create verb → no routing");
});

await check("routing requires lily_agent_draft and wraps the agent workflow", async () => {
  const routing = resolveEngineRouting("做一个审合同的智能体", [], undefined);
  assert.deepEqual(routing.requiredSuccessfulTools, ["lily_agent_draft"]);
  assert.match(routing.engineText, /^\[LILY AGENT AUTHORING WORKFLOW\]/);
  assert.match(routing.engineText, /lily_agent_draft with action=create/);
  assert.match(routing.engineText, /activation is human-only/);
  assert.ok(routing.engineText.endsWith("做一个审合同的智能体"));
  assert.equal(routing.webLearningIntent, false);
});

await check("the explicit renderer marker kind 'agent' is honoured even without intent words", async () => {
  const routing = resolveEngineRouting("帮我弄一个能审合同的", [], "agent");
  assert.deepEqual(routing.requiredSuccessfulTools, ["lily_agent_draft"]);
  const character = resolveEngineRouting("帮我弄一个", [], "character");
  assert.deepEqual(character.requiredSuccessfulTools, ["lily_character_draft"]);
  assert.match(character.engineText, /kind=character/);
  const unknownKind = resolveEngineRouting("hello", [], "bogus");
  assert.deepEqual(unknownKind.requiredSuccessfulTools, []);
});

await check("character engine text is byte-identical to before for non-agent kinds", async () => {
  const text = buildCharacterAuthoringEngineText("x", { active: true, kind: "worldBook" });
  assert.match(text, /^\[LILY CHARACTER AUTHORING WORKFLOW\]\nkind=worldBook/);
  assert.equal(buildCharacterAuthoringEngineText("plain", { active: false }), "plain");
});

await check("availability: agents need only the kill switch; role routing untouched", async () => {
  assert.deepEqual(await ensureRoutingAvailable({}, { requiredSuccessfulTools: ["lily_agent_draft"] }), { ok: true });
  process.env.LILY_AGENTS = "0";
  const denied = await ensureRoutingAvailable({}, { requiredSuccessfulTools: ["lily_agent_draft"] });
  delete process.env.LILY_AGENTS;
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "AGENTS_UNAVAILABLE");
  assert.deepEqual(await ensureRoutingAvailable({}, { requiredSuccessfulTools: [] }), { ok: true });
});

console.log(`\n${checks} checks passed (agent routing)`);
