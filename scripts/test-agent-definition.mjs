#!/usr/bin/env node
// 智能体 definition model: the ONE validated shape every producer must pass.
// Guards: complete normalized output, coded field-level rejections, id/format
// rules, byte cap, hot/cold dimension classification, renderer-safe summary.
// Run: node scripts/test-agent-definition.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  normalizeAgentDefinition,
  agentDefinitionHash,
  activeDimensions,
  hasColdDimensions,
  summarizeAgentDefinition,
} = require("../src/main/agents/agent-definition.js");
const C = require("../src/main/agents/constants.js");

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}
function rejects(input, code, field) {
  let error = null;
  try { normalizeAgentDefinition(input); } catch (err) { error = err; }
  assert.ok(error, `expected rejection for ${JSON.stringify(input).slice(0, 80)}`);
  assert.equal(error.code, code);
  if (field) assert.equal(error.field, field);
}

check("minimal definition normalizes to a COMPLETE shape with inherit defaults", () => {
  const def = normalizeAgentDefinition({ name: "  合同审查助手  " });
  assert.deepEqual(def, {
    schemaVersion: 1,
    name: "合同审查助手",
    description: "",
    icon: "",
    tags: [],
    role: null,
    starters: [],
    skills: { required: [], enabled: [] },
    knowledge: { packs: [], guidance: "" },
    model: { presetId: "" },
    tools: { mcpAllow: [], connectors: [], disallow: [] },
    autonomy: { permissionModeId: "inherit" },
    automations: [],
  });
  assert.deepEqual(activeDimensions(def), []);
  assert.equal(hasColdDimensions(def), false);
});

check("required skills are always also enabled; ids lowercased and deduped", () => {
  const def = normalizeAgentDefinition({ name: "x", skills: { required: ["Lily-Doc-Review", "lily-doc-review"], enabled: ["anthropics-docx"] } });
  assert.deepEqual(def.skills, { required: ["lily-doc-review"], enabled: ["anthropics-docx", "lily-doc-review"] });
});

check("role accepts exactly one reference kind", () => {
  assert.deepEqual(normalizeAgentDefinition({ name: "x", role: { officialCharacterId: "lily-cn-legal-counsel" } }).role, { officialCharacterId: "lily-cn-legal-counsel" });
  assert.equal(normalizeAgentDefinition({ name: "x", role: {} }).role, null);
  rejects({ name: "x", role: { officialCharacterId: "a", characterRevisionId: "b" } }, "AGENT_DEFINITION_INVALID", "role");
  rejects({ name: "x", role: { characterEntityId: "has space" } }, "AGENT_DEFINITION_INVALID", "role.characterEntityId");
});

check("field-level coded rejections", () => {
  rejects({}, "AGENT_DEFINITION_INVALID", "name");
  rejects({ name: "" }, "AGENT_DEFINITION_INVALID", "name");
  rejects({ name: 42 }, "AGENT_DEFINITION_INVALID", "name");
  rejects({ name: "x".repeat(C.MAX_AGENT_NAME_CHARS + 1) }, "AGENT_DEFINITION_INVALID", "name");
  rejects({ name: "x", skills: { required: ["Not Valid!"] } }, "AGENT_DEFINITION_INVALID", "skills.required");
  rejects({ name: "x", autonomy: { permissionModeId: "yolo" } }, "AGENT_DEFINITION_INVALID", "autonomy.permissionModeId");
  rejects({ name: "x", model: { presetId: "has space" } }, "AGENT_DEFINITION_INVALID", "model.presetId");
  rejects({ name: "x", tools: { disallow: ["bad name"] } }, "AGENT_DEFINITION_INVALID", "tools.disallow");
  rejects({ name: "x", knowledge: { packs: ["bad pack!"] } }, "AGENT_DEFINITION_INVALID", "knowledge.packs");
  assert.deepEqual(normalizeAgentDefinition({ name: "x", knowledge: { packs: ["Legal-CN-Enterprise"] } }).knowledge.packs, ["legal-cn-enterprise"]);
  rejects({ name: "x", starters: new Array(C.MAX_AGENT_STARTERS + 1).fill("s") }, "AGENT_DEFINITION_INVALID", "starters");
  rejects({ name: "x", automations: [{ prompt: "p" }] }, "AGENT_DEFINITION_INVALID", "automations[0].schedule.type");
  rejects({ name: "x", automations: [{ schedule: { type: "daily" } }] }, "AGENT_DEFINITION_INVALID", "automations[0].prompt");
  rejects({ name: "x", schemaVersion: 99 }, "AGENT_DEFINITION_INVALID", "schemaVersion");
  rejects(["array"], "AGENT_DEFINITION_INVALID", "definition");
  rejects({ name: "x", knowledge: { guidance: "g".repeat(C.MAX_AGENT_KNOWLEDGE_GUIDANCE_CHARS + 1) } }, "AGENT_DEFINITION_INVALID", "knowledge.guidance");
});

check("dangerous keys and non-plain objects are refused", () => {
  const poisoned = JSON.parse('{"name":"x","skills":{"__proto__":{"polluted":true}}}');
  rejects(poisoned, "AGENT_DEFINITION_INVALID", "skills");
  class Weird { constructor() { this.name = "x"; } }
  rejects(new Weird(), "AGENT_DEFINITION_INVALID", "definition");
});

check("control characters are stripped from text, model/inherit normalizes to empty", () => {
  const def = normalizeAgentDefinition({ name: `a${String.fromCharCode(7)}b`, description: "line1\nline2\tok", model: { presetId: "inherit" } });
  assert.equal(def.name, "ab");
  assert.equal(def.description, "line1\nline2\tok");
  assert.equal(def.model.presetId, "");
});

check("hot vs cold classification follows DIMENSION_PATHS", () => {
  const hot = normalizeAgentDefinition({ name: "x", role: { officialCharacterId: "r" }, skills: { enabled: ["lily-a"] }, knowledge: { guidance: "g" }, autonomy: { permissionModeId: "ask" } });
  assert.deepEqual(activeDimensions(hot), ["role", "skills", "knowledge", "autonomy"]);
  assert.equal(hasColdDimensions(hot), false);
  assert.equal(hasColdDimensions(normalizeAgentDefinition({ name: "x", model: { presetId: "deepseek-v4" } })), true);
  assert.equal(hasColdDimensions(normalizeAgentDefinition({ name: "x", tools: { disallow: ["lily_tool_broker_x"] } })), true);
  // Advisory tool preferences alone are hot (guidance-delivered); only
  // `disallow` reaches the serve permission map.
  assert.equal(hasColdDimensions(normalizeAgentDefinition({ name: "x", tools: { mcpAllow: ["lily_legal_search"], connectors: ["mail"] } })), false);
  assert.equal(C.DIMENSION_PATHS.tools, "cold");
});

check("automations keep structure; schedule copied by value", () => {
  const schedule = { type: "daily", hour: 9, minute: 0 };
  const def = normalizeAgentDefinition({ name: "x", automations: [{ title: "巡检", prompt: "检查收件箱", schedule, scheduleText: "每天 9:00" }] });
  schedule.hour = 23;
  assert.equal(def.automations[0].schedule.hour, 9);
  assert.deepEqual(activeDimensions(def), ["automations"]);
});

check("definition hash is stable across key order and whitespace", () => {
  const a = normalizeAgentDefinition({ name: "x", description: "d", skills: { enabled: ["lily-a", "lily-b"] } });
  const b = normalizeAgentDefinition({ skills: { enabled: ["lily-a", "lily-b"] }, description: " d ", name: "x" });
  assert.equal(agentDefinitionHash(a), agentDefinitionHash(b));
  assert.match(agentDefinitionHash(a), /^sha256:[0-9a-f]{64}$/);
});

check("byte cap is enforced as a dedicated code", () => {
  const big = { name: "x", starters: new Array(8).fill("s".repeat(200)), knowledge: { guidance: "g".repeat(4000) }, description: "d".repeat(2000), tags: new Array(16).fill("t".repeat(64)) };
  // Under the 256 KiB cap → fine.
  normalizeAgentDefinition(big);
  // Automations carry the only unbounded-ish nested object; blow it up.
  const huge = { name: "x", automations: new Array(8).fill({ prompt: "p".repeat(4000), schedule: { type: "daily", pad: "z".repeat(40_000) } }) };
  rejects(huge, "AGENT_DEFINITION_TOO_LARGE");
});

check("summary is a value copy that carries dimensions/cold flags", () => {
  const def = normalizeAgentDefinition({ name: "x", model: { presetId: "m1" }, skills: { required: ["lily-a"] } });
  const summary = summarizeAgentDefinition(def);
  assert.deepEqual(summary.dimensions, ["skills", "model"]);
  assert.equal(summary.cold, true);
  summary.skills.required.push("mutated");
  assert.deepEqual(def.skills.required, ["lily-a"]);
});

console.log(`\n${checks} checks passed (agent definition)`);
